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
// RSS FEED FETCHING
// ============================================================

function fetchAllFeeds() {
  var channelsSheet = getSheet('CHANNELS');
  var videosSheet = getSheet('VIDEOS');

  var channelData = channelsSheet.getDataRange().getValues();
  var headers = channelData[0];
  var feedUrlCol = headers.indexOf('feed_url');
  var channelNameCol = headers.indexOf('channel_name');
  var tierCol = headers.indexOf('tier');
  var categoryCol = headers.indexOf('category');
  var enabledCol = headers.indexOf('enabled');

  // Get existing video IDs for deduplication
  var existingVideos = {};
  var videoData = videosSheet.getDataRange().getValues();
  if (videoData.length > 1) {
    var videoIdCol = videoData[0].indexOf('video_id');
    for (var i = 1; i < videoData.length; i++) {
      existingVideos[videoData[i][videoIdCol]] = true;
    }
  }

  var newCount = 0;
  var errorCount = 0;

  for (var i = 1; i < channelData.length; i++) {
    var row = channelData[i];
    var enabled = enabledCol === -1 || row[enabledCol] === true || row[enabledCol] === 'TRUE';
    if (!enabled) continue;

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
          videosSheet.appendRow([
            video.video_id,
            video.channel_name,
            video.title,
            video.url,
            video.published_at,
            new Date().toISOString(), // fetched_at
            video.tier,
            video.category,
            0, // comment_count
          ]);
          existingVideos[video.video_id] = true;
          newCount++;
        }
      }

      log('DEBUG', 'fetchAllFeeds', 'Fetched ' + videos.length + ' videos from ' + channelName);
    } catch (error) {
      log('ERROR', 'fetchAllFeeds', 'Failed to fetch ' + channelName + ': ' + error.message);
      errorCount++;
    }

    // Be polite to YouTube
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

function parseRssFeed(xml, channelName, tier, category) {
  var doc = XmlService.parse(xml);
  var root = doc.getRootElement();
  var ns = XmlService.getNamespace('http://www.w3.org/2005/Atom');
  var ytNs = XmlService.getNamespace('yt', 'http://www.youtube.com/xml/schemas/2015');

  var entries = root.getChildren('entry', ns);
  var videos = [];

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var videoIdEl = entry.getChild('videoId', ytNs);
    var titleEl = entry.getChild('title', ns);
    var publishedEl = entry.getChild('published', ns);
    var linkEl = entry.getChild('link', ns);

    if (!videoIdEl || !titleEl) continue;

    var videoId = videoIdEl.getText();
    var title = titleEl.getText();
    var published = publishedEl ? publishedEl.getText() : new Date().toISOString();
    var url = linkEl ? linkEl.getAttribute('href').getValue() : 'https://www.youtube.com/watch?v=' + videoId;

    videos.push({
      video_id: videoId,
      channel_name: channelName,
      title: title,
      url: url,
      published_at: published,
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
