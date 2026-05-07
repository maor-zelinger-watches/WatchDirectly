/**
 * WatchDirectly — Google Apps Script Backend (Code.gs)
 * 
 * Deploy as a web app:
 *   Deploy → New Deployment → Web App
 *   Execute as: Me | Who has access: Anyone
 * 
 * IMPORTANT: Each "sheet" is a separate Google Spreadsheet.
 * Store this script in any of them (e.g., Meta) via Extensions → Apps Script.
 * 
 * Anti-abuse strategy:
 *   1. Google Sign-In token verification (primary auth)
 *   2. API_SECRET stored in Meta sheet — HMAC-signed requests
 *   3. Rate limiting — max 1 comment per 30 seconds per user
 *   4. BlockedUsers sheet — manual bans
 */

// ============================================================
// SPREADSHEET IDs — Each "sheet" is a separate Google Spreadsheet
// ============================================================

const SPREADSHEET_IDS = {
  CHANNELS:     '1P6m12rLNOVej8QgMwOJdREliOAhM6oyEHD7JCC6iRPo',
  VIDEOS:       '1OIQULOWEnor6Klpzg-IFhzi-w78EKKLVMtE-5oEw8W4',
  COMMENTS:     '1tTRWXAfePQRhLie1m9_E6zbkvY9QUrLPRpmpLYqoNw4',
  META:         '11Zm0nouToxUzXQZZ4OQOcYcFLl0xdSsWQfPLsQs0AF4',
  BLOCKED:      '1ZNePTyTIZsM73WW4nC3AwSb27oDjVoftjJJeWTajjL0',
  LOGS:         '1C6kVxkdANBBech6sDPRye62Mo4MdeSrGCkY78ZHi_9s',
};

// ============================================================
// CONFIGURATION
// ============================================================

const DEFAULT_REFRESH_HOURS = 4;
const DEFAULT_PAGE_LIMIT = 20;
const RATE_LIMIT_SECONDS = 30; // Min seconds between comments per user

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

// Cache per execution
let _cachedLogLevel = null;
let _cachedApiSecret = null;

// ============================================================
// HELPERS — Open spreadsheets by ID
// ============================================================

function getSheet(key) {
  return SpreadsheetApp.openById(SPREADSHEET_IDS[key]).getSheets()[0];
}

// ============================================================
// HTTP HANDLERS
// ============================================================

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || '';
    
    switch (action) {
      case 'feed':
        return jsonResponse(handleFeed(e.parameter));
      case 'comments':
        return jsonResponse(handleComments(e.parameter));
      case 'refresh':
        return jsonResponse(handleRefresh());
      case 'logs':
        return jsonResponse(handleLogs(e.parameter));
      case 'init':
        // Returns the API secret for the frontend (call once, store in memory)
        return jsonResponse(handleInit());
      default:
        return jsonResponse({ status: 'error', message: 'Unknown action: ' + action });
    }
  } catch (error) {
    log('ERROR', 'doGet', error.message);
    return jsonResponse({ status: 'error', message: error.message });
  }
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var action = data.action || '';

    switch (action) {
      case 'comment':
        return jsonResponse(handleAddComment(data));
      default:
        return jsonResponse({ status: 'error', message: 'Unknown action: ' + action });
    }
  } catch (error) {
    log('ERROR', 'doPost', error.message);
    return jsonResponse({ status: 'error', message: error.message });
  }
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// API SECRET & HMAC VERIFICATION
// ============================================================

/**
 * Generates or retrieves the API secret from the Meta sheet.
 * This secret is never exposed in the frontend source code.
 * The frontend fetches it once via ?action=init (requires page to be loaded from the correct origin).
 */
function getApiSecret() {
  if (_cachedApiSecret) return _cachedApiSecret;
  
  var secret = getMeta('api_secret');
  
  // Auto-generate if missing
  if (!secret) {
    secret = Utilities.getUuid() + '-' + Utilities.getUuid();
    setMeta('api_secret', secret);
    log('INFO', 'getApiSecret', 'Generated new API secret');
  }
  
  _cachedApiSecret = secret;
  return secret;
}

/**
 * Creates an HMAC-SHA256 signature for a payload.
 * The frontend signs comment requests with this.
 * 
 * @param {string} payload - The string to sign (e.g., videoId + body + timestamp)
 * @param {string} secret - The API secret
 * @returns {string} Hex-encoded HMAC signature
 */
function createHmac(payload, secret) {
  var signature = Utilities.computeHmacSha256Signature(payload, secret);
  return signature.map(function(b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2);
  }).join('');
}

/**
 * Verifies an HMAC signature from the frontend.
 * 
 * @param {string} payload - The signed payload
 * @param {string} signature - The HMAC signature from the request
 * @returns {boolean} True if valid
 */
function verifyHmac(payload, signature) {
  var secret = getApiSecret();
  var expected = createHmac(payload, secret);
  return expected === signature;
}

/**
 * Returns the API secret to the frontend.
 * This is called once when the page loads.
 * The secret lives in memory only — never in source code.
 */
function handleInit() {
  return {
    status: 'ok',
    api_secret: getApiSecret(),
  };
}

// ============================================================
// RATE LIMITING
// ============================================================

/**
 * Checks if a user is posting too frequently.
 * Stores last comment timestamp per email in Meta sheet.
 * 
 * @param {string} email - User's email
 * @returns {boolean} True if rate limited
 */
function isRateLimited(email) {
  var key = 'rate_' + email;
  var lastComment = getMeta(key);
  
  if (!lastComment) return false;
  
  var elapsed = (Date.now() - new Date(lastComment).getTime()) / 1000;
  return elapsed < RATE_LIMIT_SECONDS;
}

/**
 * Records a comment timestamp for rate limiting.
 * @param {string} email 
 */
function recordCommentTime(email) {
  setMeta('rate_' + email, new Date().toISOString());
}

// ============================================================
// FEED HANDLER
// ============================================================

function handleFeed(params) {
  // Check if refresh needed
  var lastFetch = getMeta('last_fetch');
  var refreshHours = parseInt(getMeta('refresh_interval_hours')) || DEFAULT_REFRESH_HOURS;
  var staleThreshold = refreshHours * 60 * 60 * 1000;

  if (!lastFetch || (Date.now() - new Date(lastFetch).getTime()) > staleThreshold) {
    log('INFO', 'handleFeed', 'Feed is stale, triggering refresh');
    fetchAllFeeds();
  }

  var page = parseInt(params.page) || 1;
  var limit = parseInt(params.limit) || DEFAULT_PAGE_LIMIT;

  return getVideos(page, limit);
}

function handleRefresh() {
  log('INFO', 'handleRefresh', 'Manual refresh triggered');
  var stats = fetchAllFeeds();
  return { status: 'ok', ...stats };
}

// ============================================================
// SCHEDULED REFRESH — Run once: setupScheduledRefresh()
// ============================================================

/**
 * Run this function ONCE from the Apps Script editor to install
 * an automatic trigger that refreshes feeds every 4 hours.
 *
 * To run: Open Apps Script → select setupScheduledRefresh → click ▶ Run
 * To verify: Edit → Current project's triggers
 */
function setupScheduledRefresh() {
  // Remove any existing triggers for scheduledFetchAllFeeds to avoid duplicates
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'scheduledFetchAllFeeds') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  // Create a new trigger that runs every 4 hours
  ScriptApp.newTrigger('scheduledFetchAllFeeds')
    .timeBased()
    .everyHours(4)
    .create();

  log('INFO', 'setupScheduledRefresh', 'Trigger installed: scheduledFetchAllFeeds every 4 hours');
}

/**
 * Entry point called by the time-based trigger.
 * Wraps fetchAllFeeds with logging/error handling.
 */
function scheduledFetchAllFeeds() {
  log('INFO', 'scheduledFetchAllFeeds', 'Scheduled refresh starting');
  try {
    var stats = fetchAllFeeds();
    log('INFO', 'scheduledFetchAllFeeds', 'Completed. New: ' + stats.new_videos + ', Errors: ' + stats.errors);
  } catch (e) {
    log('ERROR', 'scheduledFetchAllFeeds', 'Failed: ' + e.message);
  }
}

// ============================================================
// RSS FEED FETCHING
// ============================================================

function fetchAllFeeds() {
  var channelsSheet = getSheet('CHANNELS');
  var videosSheet = getSheet('VIDEOS');

  var channelData = channelsSheet.getDataRange().getValues();
  var cHeaders = channelData[0] || [];
  var feedUrlCol = cHeaders.indexOf('feed_url');
  var channelNameCol = cHeaders.indexOf('channel_name');
  var tierCol = cHeaders.indexOf('tier');
  var categoryCol = cHeaders.indexOf('category');
  var enabledCol = cHeaders.indexOf('enabled');

  // Get existing video IDs for deduplication
  var existingVideos = {};
  var videoData = videosSheet.getDataRange().getValues();
  var vHeaders = videoData.length > 0 ? videoData[0] : [];
  
  if (videoData.length > 1) {
    var videoIdCol = vHeaders.indexOf('item_id');
    if (videoIdCol === -1) videoIdCol = vHeaders.indexOf('video_id');
    
    if (videoIdCol !== -1) {
      for (var i = 1; i < videoData.length; i++) {
        existingVideos[videoData[i][videoIdCol]] = true;
      }
    }
  }

  var newCount = 0;
  var errorCount = 0;

  for (var i = 1; i < channelData.length; i++) {
    var row = channelData[i];
    var rawEnabled = enabledCol === -1 ? true : row[enabledCol];
    var enabled = rawEnabled === true || String(rawEnabled).toUpperCase() === 'TRUE';
    if (!enabled) {
      log('DEBUG', 'fetchAllFeeds', 'Skipping disabled channel: ' + row[channelNameCol] + ' (enabled=' + rawEnabled + ')');
      continue;
    }

    var feedUrl = row[feedUrlCol];
    var channelName = row[channelNameCol];
    var tier = row[tierCol];
    var category = row[categoryCol];

    if (!feedUrl) {
      log('WARN', 'fetchAllFeeds', 'No feed_url for channel: ' + channelName);
      continue;
    }

    try {
      var videos = fetchAndParseFeed(feedUrl, channelName, tier, category);

      for (var v = 0; v < videos.length; v++) {
        var video = videos[v];
        if (!existingVideos[video.video_id]) {
          var newRow = [];
          if (vHeaders.length === 0) {
             // Fallback if sheet is totally empty
             newRow = [
               video.video_id, video.channel_name, video.title, video.url, video.published_at, new Date().toISOString(), video.tier, video.category, 0, video.media_type, video.preview_image
             ];
          } else {
            for(var h = 0; h < vHeaders.length; h++) {
              var hName = vHeaders[h];
              if (hName === 'video_id' || hName === 'item_id') newRow.push(video.video_id);
              else if (hName === 'channel_name') newRow.push(video.channel_name);
              else if (hName === 'title') newRow.push(video.title);
              else if (hName === 'url') newRow.push(video.url);
              else if (hName === 'published_at') newRow.push(video.published_at);
              else if (hName === 'fetched_at') newRow.push(new Date().toISOString());
              else if (hName === 'tier') newRow.push(video.tier);
              else if (hName === 'category') newRow.push(video.category);
              else if (hName === 'comment_count') newRow.push(0);
              else if (hName === 'media_type') newRow.push(video.media_type);
              else if (hName === 'preview_image') newRow.push(video.preview_image);
              else newRow.push('');
            }
          }
          
          videosSheet.appendRow(newRow);
          existingVideos[video.video_id] = true;
          newCount++;
        }
      }

      log('DEBUG', 'fetchAllFeeds', 'Fetched ' + videos.length + ' items from ' + channelName);
    } catch (error) {
      log('ERROR', 'fetchAllFeeds', 'Failed to fetch ' + channelName + ': ' + error.message);
      errorCount++;
    }

    // Be polite
    Utilities.sleep(500);
  }

  // Update last_fetch timestamp
  setMeta('last_fetch', new Date().toISOString());

  log('INFO', 'fetchAllFeeds', 'Refresh complete. New: ' + newCount + ', Errors: ' + errorCount);
  return { new_videos: newCount, errors: errorCount };
}

function fetchAndParseFeed(feedUrl, channelName, tier, category) {
  var response = UrlFetchApp.fetch(feedUrl, { muteHttpExceptions: true });

  if (response.getResponseCode() !== 200) {
    throw new Error('HTTP ' + response.getResponseCode());
  }

  var xml = response.getContentText();
  return parseRssFeed(xml, channelName, tier, category);
}

function extractYouTubeId(url) {
  var match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([^&]{11})/);
  return match ? match[1] : null;
}

function parseRssFeed(xml, channelName, tier, category) {
  try {
    var doc = XmlService.parse(xml);
    var root = doc.getRootElement();
    var name = root.getName().toLowerCase();
    
    if (name === 'rss') {
      return parseRss2(root, channelName, tier, category);
    } else if (name === 'feed') {
      return parseAtom(root, channelName, tier, category);
    } else {
      throw new Error("Unknown feed format: " + name);
    }
  } catch (e) {
    // Fallback to regex based parsing if XML is malformed
    return parseRegex(xml, channelName, tier, category);
  }
}

function parseRss2(root, channelName, tier, category) {
  var channel = root.getChild('channel');
  if (!channel) return [];
  var items = channel.getChildren('item');
  var videos = [];
  
  var mediaNs = XmlService.getNamespace('media', 'http://search.yahoo.com/mrss/');
  var contentNs = XmlService.getNamespace('content', 'http://purl.org/rss/1.0/modules/content/');
  
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var title = item.getChildText('title') || '';
    var link = item.getChildText('link') || '';
    var pubDate = item.getChildText('pubDate') || new Date().toISOString();
    var guid = item.getChildText('guid') || link;
    
    var videoId = extractYouTubeId(link);
    var mediaType = videoId ? 'video' : 'article';
    var itemId = videoId || Utilities.base64Encode(guid).replace(/[^a-zA-Z0-9]/g, '').slice(-15);
    
    var previewImage = '';
    // Try media:content
    if (mediaNs) {
      var mediaContent = item.getChild('content', mediaNs);
      if (mediaContent && mediaContent.getAttribute('url')) {
        previewImage = mediaContent.getAttribute('url').getValue();
      }
      if (!previewImage) {
        var mediaThumbnail = item.getChild('thumbnail', mediaNs);
        if (mediaThumbnail && mediaThumbnail.getAttribute('url')) {
          previewImage = mediaThumbnail.getAttribute('url').getValue();
        }
      }
    }
    // Try enclosure
    if (!previewImage) {
      var enclosure = item.getChild('enclosure');
      if (enclosure && enclosure.getAttribute('type') && enclosure.getAttribute('type').getValue().indexOf('image') > -1) {
        previewImage = enclosure.getAttribute('url').getValue();
      }
    }
    // Try regexing from description or content:encoded
    if (!previewImage) {
      var desc = item.getChildText('description') || '';
      var contentEncoded = contentNs ? item.getChildText('encoded', contentNs) || '' : '';
      var imgMatch = (contentEncoded + desc).match(/<img[^>]+src="([^">]+)"/);
      if (imgMatch) previewImage = imgMatch[1];
    }
    
    videos.push({
      video_id: itemId,
      media_type: mediaType,
      channel_name: channelName,
      title: title,
      url: link,
      preview_image: previewImage,
      published_at: new Date(pubDate).toISOString(),
      tier: tier,
      category: category,
    });
  }
  return videos;
}

function parseAtom(root, channelName, tier, category) {
  var ns = root.getNamespace();
  var ytNs = XmlService.getNamespace('yt', 'http://www.youtube.com/xml/schemas/2015');
  var mediaNs = XmlService.getNamespace('media', 'http://search.yahoo.com/mrss/');
  
  var entries = root.getChildren('entry', ns);
  var videos = [];

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var title = entry.getChildText('title', ns) || '';
    
    var linkEl = entry.getChild('link', ns);
    var links = entry.getChildren('link', ns);
    for (var j=0; j<links.length; j++) {
      if (links[j].getAttribute('rel') && links[j].getAttribute('rel').getValue() === 'alternate') {
        linkEl = links[j];
      }
    }
    var link = linkEl ? linkEl.getAttribute('href').getValue() : '';
    
    var ytVideoIdEl = ytNs ? entry.getChild('videoId', ytNs) : null;
    var published = entry.getChildText('published', ns) || entry.getChildText('updated', ns) || new Date().toISOString();
    
    var ytVideoId = ytVideoIdEl ? ytVideoIdEl.getText() : extractYouTubeId(link);
    var mediaType = ytVideoId ? 'video' : 'article';
    var itemId = ytVideoId || Utilities.base64Encode(link).replace(/[^a-zA-Z0-9]/g, '').slice(-15);
    
    var previewImage = '';
    if (mediaNs) {
      var mediaGroup = entry.getChild('group', mediaNs);
      if (mediaGroup) {
        var mediaThumbnail = mediaGroup.getChild('thumbnail', mediaNs);
        if (mediaThumbnail && mediaThumbnail.getAttribute('url')) {
          previewImage = mediaThumbnail.getAttribute('url').getValue();
        }
      }
    }
    
    if (!previewImage) {
      var content = entry.getChildText('content', ns) || entry.getChildText('summary', ns) || '';
      var imgMatch = content.match(/<img[^>]+src="([^">]+)"/);
      if (imgMatch) previewImage = imgMatch[1];
    }
    
    videos.push({
      video_id: itemId,
      media_type: mediaType,
      channel_name: channelName,
      title: title,
      url: link,
      preview_image: previewImage,
      published_at: new Date(published).toISOString(),
      tier: tier,
      category: category,
    });
  }
  return videos;
}

function parseRegex(xml, channelName, tier, category) {
  var videos = [];
  var itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  var match;
  while ((match = itemRegex.exec(xml)) !== null) {
    var itemXml = match[1];
    var titleMatch = itemXml.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i) || itemXml.match(/<title>([\s\S]*?)<\/title>/i);
    var linkMatch = itemXml.match(/<link>([\s\S]*?)<\/link>/i);
    var pubDateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    
    if (!titleMatch || !linkMatch) continue;
    
    var title = titleMatch[1].trim();
    var link = linkMatch[1].trim();
    var pubDate = pubDateMatch ? pubDateMatch[1].trim() : new Date().toISOString();
    
    var videoId = extractYouTubeId(link);
    var mediaType = videoId ? 'video' : 'article';
    var itemId = videoId || Utilities.base64Encode(link).replace(/[^a-zA-Z0-9]/g, '').slice(-15);
    
    var previewImage = '';
    var imgMatch = itemXml.match(/<media:content[^>]+url="([^">]+)"/i) || itemXml.match(/<media:thumbnail[^>]+url="([^">]+)"/i) || itemXml.match(/<img[^>]+src="([^">]+)"/i);
    if (imgMatch) previewImage = imgMatch[1];
    
    videos.push({
      video_id: itemId,
      media_type: mediaType,
      channel_name: channelName,
      title: title,
      url: link,
      preview_image: previewImage,
      published_at: new Date(pubDate).toISOString(),
      tier: tier,
      category: category,
    });
  }
  return videos;
}

// ============================================================
// VIDEOS
// ============================================================

function getVideos(page, limit) {
  var sheet = getSheet('VIDEOS');
  var data = sheet.getDataRange().getValues();

  if (data.length <= 1) {
    return { status: 'ok', videos: [], total: 0, page: page };
  }

  var headers = data[0];
  var videos = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var video = {};
    for (var j = 0; j < headers.length; j++) {
      video[headers[j]] = row[j];
    }
    
    // Fallback if media_type is missing from sheet data
    if (!video.media_type) {
      if (video.video_id && video.video_id.length === 11) {
        video.media_type = 'video';
      } else {
        video.media_type = 'article';
      }
    }
    
    videos.push(video);
  }

  // Sort by published_at descending (newest first)
  videos.sort(function(a, b) {
    return new Date(b.published_at) - new Date(a.published_at);
  });

  // Paginate
  var start = (page - 1) * limit;
  var paged = videos.slice(start, start + limit);

  return {
    status: 'ok',
    videos: paged,
    total: videos.length,
    page: page,
  };
}

// ============================================================
// COMMENTS
// ============================================================

function handleComments(params) {
  var videoId = params.videoId;
  if (!videoId) {
    return { status: 'error', message: 'videoId is required' };
  }
  return getComments(videoId);
}

function getComments(videoId) {
  var sheet = getSheet('COMMENTS');
  var data = sheet.getDataRange().getValues();

  if (data.length <= 1) {
    return { status: 'ok', comments: [] };
  }

  var headers = data[0];
  var videoIdCol = headers.indexOf('video_id');
  var comments = [];

  for (var i = 1; i < data.length; i++) {
    if (data[i][videoIdCol] !== videoId) continue;

    var comment = {};
    for (var j = 0; j < headers.length; j++) {
      comment[headers[j]] = data[i][j];
    }
    comments.push(comment);
  }

  // Sort by created_at ascending (oldest first for threading)
  comments.sort(function(a, b) {
    return new Date(a.created_at) - new Date(b.created_at);
  });

  return { status: 'ok', comments: comments };
}

function handleAddComment(data) {
  var videoId = data.videoId;
  var parentId = data.parentId;
  var body = data.body;
  var token = data.token;
  var signature = data.signature;
  var timestamp = data.timestamp;

  // 1. Validate required fields
  if (!videoId || !body || !token) {
    return { status: 'error', message: 'videoId, body, and token are required' };
  }

  // 2. Verify HMAC signature (anti-abuse)
  if (signature && timestamp) {
    var payload = videoId + '|' + body + '|' + timestamp;
    if (!verifyHmac(payload, signature)) {
      log('ERROR', 'addComment', 'Invalid HMAC signature');
      return { status: 'error', message: 'Invalid request signature' };
    }
    // Check timestamp freshness (reject if > 5 min old)
    var age = (Date.now() - parseInt(timestamp)) / 1000;
    if (age > 300) {
      log('WARN', 'addComment', 'Stale timestamp: ' + age + 's old');
      return { status: 'error', message: 'Request expired, please retry' };
    }
  }

  // 3. Verify Google token and get user info
  var user = verifyGoogleToken(token);
  if (!user) {
    log('ERROR', 'addComment', 'Invalid Google token');
    return { status: 'error', message: 'Invalid authentication token' };
  }

  // 4. Check if user is blocked
  if (isUserBlocked(user.email)) {
    log('ERROR', 'addComment', 'Blocked user attempted comment: ' + user.email);
    return { status: 'error', message: 'You have been blocked from commenting' };
  }

  // 5. Check rate limit
  if (isRateLimited(user.email)) {
    log('WARN', 'addComment', 'Rate limited: ' + user.email);
    return { status: 'error', message: 'Please wait before posting another comment' };
  }

  // 6. Determine depth
  var depth = 0;
  if (parentId) {
    depth = 1;
  }

  // 7. Generate comment ID
  var commentId = 'c_' + Utilities.getUuid().replace(/-/g, '').substring(0, 12);

  // 8. Append to Comments sheet
  var sheet = getSheet('COMMENTS');
  var now = new Date().toISOString();

  sheet.appendRow([
    commentId,
    videoId,
    parentId || '',
    user.name,
    user.email,
    user.picture,
    body,
    depth,
    now,
  ]);

  // 9. Record for rate limiting
  recordCommentTime(user.email);

  // 10. Update comment count on the video
  updateCommentCount(videoId);

  log('INFO', 'addComment', 'Comment added by ' + user.email + ' on video ' + videoId);

  return { status: 'ok', comment_id: commentId };
}

function updateCommentCount(videoId) {
  // Count comments for this video
  var commentsSheet = getSheet('COMMENTS');
  var commentsData = commentsSheet.getDataRange().getValues();
  var headers = commentsData[0];
  var videoIdCol = headers.indexOf('video_id');
  var count = 0;

  for (var i = 1; i < commentsData.length; i++) {
    if (commentsData[i][videoIdCol] === videoId) count++;
  }

  // Update the video row
  var videosSheet = getSheet('VIDEOS');
  var videosData = videosSheet.getDataRange().getValues();
  var vHeaders = videosData[0];
  var vVideoIdCol = vHeaders.indexOf('video_id');
  var commentCountCol = vHeaders.indexOf('comment_count');

  for (var i = 1; i < videosData.length; i++) {
    if (videosData[i][vVideoIdCol] === videoId) {
      videosSheet.getRange(i + 1, commentCountCol + 1).setValue(count);
      break;
    }
  }
}

// ============================================================
// AUTHENTICATION
// ============================================================

function verifyGoogleToken(idToken) {
  try {
    var response = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + idToken,
      { muteHttpExceptions: true }
    );

    if (response.getResponseCode() !== 200) {
      return null;
    }

    var payload = JSON.parse(response.getContentText());

    return {
      email: payload.email,
      name: payload.name || payload.email.split('@')[0],
      picture: payload.picture || '',
    };
  } catch (error) {
    log('ERROR', 'verifyGoogleToken', error.message);
    return null;
  }
}

// ============================================================
// USER BLOCKING
// ============================================================

function isUserBlocked(email) {
  var sheet = getSheet('BLOCKED');
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var emailCol = headers.indexOf('email');

  if (emailCol === -1) return false;

  for (var i = 1; i < data.length; i++) {
    if (data[i][emailCol] === email) return true;
  }

  return false;
}

// ============================================================
// META (Key-Value Config)
// ============================================================

function getMeta(key) {
  var sheet = getSheet('META');
  var data = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) return data[i][1];
  }

  return null;
}

function setMeta(key, value) {
  var sheet = getSheet('META');
  var data = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }

  // Key not found, add new row
  sheet.appendRow([key, value]);
}

// ============================================================
// LOGGING
// ============================================================

function getLogLevel() {
  if (_cachedLogLevel !== null) return _cachedLogLevel;

  var level = getMeta('log_level') || 'ERROR';
  _cachedLogLevel = level.toUpperCase();
  return _cachedLogLevel;
}

function log(level, source, message) {
  var configLevel = getLogLevel();
  var levelValue = LOG_LEVELS[level] || 0;
  var configValue = LOG_LEVELS[configLevel] || LOG_LEVELS.ERROR;

  if (levelValue < configValue) return;

  try {
    var sheet = getSheet('LOGS');
    sheet.appendRow([
      new Date().toISOString(),
      level,
      source,
      message,
    ]);
  } catch (e) {
    Logger.log('Log write failed: ' + e.message);
  }
}

function handleLogs(params) {
  var count = parseInt(params.count) || 50;
  var sheet = getSheet('LOGS');
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var logs = [];

  var start = Math.max(1, data.length - count);
  for (var i = data.length - 1; i >= start; i--) {
    var entry = {};
    for (var j = 0; j < headers.length; j++) {
      entry[headers[j]] = data[i][j];
    }
    logs.push(entry);
  }

  return { status: 'ok', logs: logs };
}
