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

// OAuth client ID this app's Google Sign-In tokens are minted for. Every ID
// token MUST carry this as its `aud` claim, or it was issued to a different
// site and must be rejected — Google's tokeninfo endpoint validates the token
// signature and expiry but NOT the audience. Keep in sync with GOOGLE_CLIENT_ID
// in js/app.js.
const GOOGLE_CLIENT_ID = '58088759188-uhqgajeoe8h218h3o6pql634pkcjsu70.apps.googleusercontent.com';

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

// Cache per execution
let _cachedLogLevel = null;


// ============================================================
// HELPERS — Open spreadsheets by ID
// ============================================================

function getSheet(key) {
  return SpreadsheetApp.openById(SPREADSHEET_IDS[key]).getSheets()[0];
}

/**
 * Finds the video/item ID column index, checking both 'video_id' and 'item_id' headers.
 * @param {string[]} headers - Array of column header names
 * @returns {number} Column index, or -1 if neither found
 */
function findVideoIdCol(headers) {
  var col = headers.indexOf('video_id');
  if (col === -1) col = headers.indexOf('item_id');
  return col;
}

/**
 * Decodes HTML entities in RSS/Atom feed text.
 * Handles named entities (&amp; &lt; etc.), decimal (&#8217;), and hex (&#x2019;).
 * @param {string} text
 * @returns {string}
 */
function decodeHtmlEntities(text) {
  if (!text) return '';
  // &amp; is decoded FIRST: feeds routinely double-escape (&amp;#39;,
  // &amp;quot;), and the numeric/named passes below can only decode the
  // inner entity once the &amp; wrapper is unwrapped. With &amp; in the
  // middle (as before), &amp;#39; came out as the literal text "&#39;".
  var decoded = text
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&#x([0-9a-fA-F]+);/g, function(_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
  return decoded;
}

/**
 * Parses a feed date string to an ISO timestamp, falling back to "now" for a
 * missing or malformed date. new Date(bad).toISOString() throws RangeError,
 * which previously propagated up and dropped the ENTIRE channel's items for
 * that run (for Atom feeds the regex fallback finds no <item> and returns []).
 * One unparseable pubDate must not lose the other ~14 videos in the same feed.
 * @param {string} dateStr
 * @returns {string} ISO 8601 timestamp
 */
function toIsoDate(dateStr) {
  var d = new Date(dateStr);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
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
      case 'commentsBatch':
        return jsonResponse(handleCommentsBatch(e.parameter));
      case 'topWeek':
        return jsonResponse(handleTopWeek(e.parameter));
      case 'refresh':
        return jsonResponse(handleRefresh());
      case 'logs':
        return jsonResponse(handleLogs(e.parameter));
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
      case 'vote':
        return jsonResponse(handleVote(data));
      case 'myVotes':
        return jsonResponse(handleMyVotes(data));
      case 'star':
        return jsonResponse(handleStar(data));
      case 'myStars':
        return jsonResponse(handleMyStars(data));
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

  return getVideos(page, limit, params.cursor || '');
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
  // One crawl at a time. Concurrent runs (scheduled trigger + stale-feed
  // web requests) raced each other: both self-initialized columns, both
  // appended rows against the same stale dedup snapshot, and both wrote
  // last_fetch (duplicate Meta rows / lost updates). The script lock is
  // held only around the marker check-and-set — holding it for the whole
  // multi-minute crawl would starve comment/vote posts, which share it.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
  } catch (e) {
    return { new_videos: 0, errors: 0, skipped: true };
  }
  try {
    var inProgress = getMeta('fetch_in_progress');
    // A marker older than 10 min is a crashed run — Apps Script hard-caps
    // executions at 6 min, so it can't still be crawling.
    if (inProgress && (Date.now() - new Date(inProgress).getTime()) < 10 * 60 * 1000) {
      log('INFO', 'fetchAllFeeds', 'Refresh already running — skipping');
      return { new_videos: 0, errors: 0, skipped: true };
    }
    setMeta('fetch_in_progress', new Date().toISOString());
  } finally {
    lock.releaseLock();
  }

  try {
    return crawlAllFeeds();
  } finally {
    setMeta('fetch_in_progress', '');
  }
}

function crawlAllFeeds() {
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
  var existingRowById = {}; // video_id -> 1-based sheet row, for view-count refresh
  var videoData = videosSheet.getDataRange().getValues();
  var vHeaders = videoData.length > 0 ? videoData[0] : [];
  // A blank sheet reads back as [['']] — treat that as "no headers" so the
  // empty-sheet fallback path (below) runs instead of self-init corrupting it.
  if (vHeaders.length === 1 && vHeaders[0] === '') vHeaders = [];

  // Self-initialize: add the view_count column if the sheet predates view tracking
  var viewCountCol = vHeaders.indexOf('view_count');
  if (viewCountCol === -1 && vHeaders.length > 0) {
    viewCountCol = vHeaders.length;
    videosSheet.getRange(1, viewCountCol + 1).setValue('view_count');
    vHeaders.push('view_count');
  }

  if (videoData.length > 1) {
    var videoIdCol = vHeaders.indexOf('item_id');
    if (videoIdCol === -1) videoIdCol = vHeaders.indexOf('video_id');

    if (videoIdCol !== -1) {
      for (var i = 1; i < videoData.length; i++) {
        existingVideos[videoData[i][videoIdCol]] = true;
        existingRowById[videoData[i][videoIdCol]] = i + 1;
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

    var urlCol = cHeaders.indexOf('url');
    var feedUrl = row[feedUrlCol] || (urlCol !== -1 ? row[urlCol] : '');
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
             // Fallback if sheet is totally empty (order matches the standard schema)
             newRow = [
               video.video_id, video.channel_name, video.title, video.url, video.published_at, new Date().toISOString(), video.tier, video.category, 0, 0, video.media_type, video.preview_image, video.view_count || 0
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
              else if (hName === 'vote_count') newRow.push(0);
              else if (hName === 'media_type') newRow.push(video.media_type);
              else if (hName === 'preview_image') newRow.push(video.preview_image);
              else if (hName === 'view_count') newRow.push(video.view_count || 0);
              else newRow.push('');
            }
          }

          videosSheet.appendRow(newRow);
          existingVideos[video.video_id] = true;
          newCount++;
        } else if (viewCountCol !== -1 && video.view_count && existingRowById[video.video_id]) {
          // Views were captured at first ingest (hours after publish, when
          // they're lowest) — refresh them while the video is still inside
          // the ~15-entry RSS window. Older videos keep their last count.
          videosSheet.getRange(existingRowById[video.video_id], viewCountCol + 1).setValue(video.view_count);
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
  var maxRetries = 4;
  var lastError = null;

  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      var delay = Math.pow(2, attempt) * 1000; // 2s, 4s
      log('WARN', 'fetchAndParseFeed', 'Retry ' + attempt + '/' + maxRetries + ' for ' + channelName + ' after ' + (delay/1000) + 's');
      Utilities.sleep(delay);
    }

    var response = UrlFetchApp.fetch(feedUrl, { muteHttpExceptions: true });
    var code = response.getResponseCode();

    if (code === 200) {
      var xml = response.getContentText();
      return parseRssFeed(xml, channelName, tier, category);
    }

    lastError = 'HTTP ' + code;
  }

  throw new Error(lastError);
}

function extractYouTubeId(url) {
  var match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/|live\/))([^&]{11})/);
  return match ? match[1] : null;
}

/**
 * Extracts the best preview image from HTML content using multiple strategies.
 * Tries (in order): <img src>, <img srcset>, <figure> images, data-src lazy-load.
 * Filters out tiny icons, avatars, tracking pixels, and ad images.
 *
 * @param {string} html - HTML content (description, content:encoded, etc.)
 * @returns {string} Best image URL or empty string
 */
function extractImageFromHtml(html) {
  if (!html) return '';

  // Unescape CDATA and HTML entities
  var clean = html
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');

  // Collect all candidate image URLs
  var candidates = [];

  // 1. Standard <img src="...">
  var imgSrcPattern = /<img[^>]+src=["']([^"']+)["']/gi;
  var m;
  while ((m = imgSrcPattern.exec(clean)) !== null) {
    candidates.push(m[1]);
  }

  // 2. data-src (lazy-loaded images)
  var dataSrcPattern = /<img[^>]+data-src=["']([^"']+)["']/gi;
  while ((m = dataSrcPattern.exec(clean)) !== null) {
    candidates.push(m[1]);
  }

  // 3. srcset (pick the largest)
  var srcsetPattern = /<img[^>]+srcset=["']([^"']+)["']/gi;
  while ((m = srcsetPattern.exec(clean)) !== null) {
    var srcsetEntries = m[1].split(',');
    // Sort by width descriptor (e.g., "url 800w") and pick largest
    var best = srcsetEntries
      .map(function(e) {
        var parts = e.trim().split(/\s+/);
        var w = parseInt((parts[1] || '0').replace('w', ''));
        return { url: parts[0], width: w || 0 };
      })
      .sort(function(a, b) { return b.width - a.width; });
    if (best.length > 0 && best[0].url) {
      candidates.unshift(best[0].url); // Prefer largest srcset
    }
  }

  // 4. <figure> background-image
  var bgPattern = /background-image:\s*url\(["']?([^"')]+)["']?\)/gi;
  while ((m = bgPattern.exec(clean)) !== null) {
    candidates.push(m[1]);
  }

  // Filter out junk
  var dominated = /gravatar|avatar|icon|logo|pixel|track|badge|emoji|smil|ad\-|ads\.|doubleclick|facebook\.com\/tr|1x1|spacer/i;
  var imageExt = /\.(jpg|jpeg|png|webp|gif|avif)/i;

  for (var i = 0; i < candidates.length; i++) {
    var url = candidates[i].trim();
    if (!url || url.length < 10) continue;
    if (dominated.test(url)) continue;
    // Prefer URLs that look like actual images
    if (imageExt.test(url) || url.indexOf('wp-content/uploads') > -1 || url.indexOf('cdn') > -1) {
      return url;
    }
  }

  // Return first non-junk candidate even without image extension
  for (var j = 0; j < candidates.length; j++) {
    var u = candidates[j].trim();
    if (u && u.length > 10 && !dominated.test(u)) return u;
  }

  return '';
}

/**
 * Last-resort: fetch the article page and extract og:image.
 * Only called for articles that have no image from the feed.
 * Uses a browser User-Agent and short timeout.
 *
 * @param {string} articleUrl - The article URL to fetch
 * @returns {string} og:image URL or empty string
 */
/**
 * Parses an IPv4 host written in any inet_aton form — dotted decimal,
 * plain decimal (2130706433), octal (017700000001), hex (0x7f000001),
 * or fewer-than-4 dotted parts — into a 32-bit number.
 *
 * @param {string} host - Hostname to try as an IPv4 literal
 * @returns {number|null} The address as a number, or null if not numeric
 */
function parseIpv4(host) {
  if (!/^[0-9a-fA-FxX.]+$/.test(host)) return null;
  var parts = host.split('.');
  if (parts.length > 4) return null;

  var nums = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    var n;
    if (/^0[xX][0-9a-fA-F]+$/.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]*$/.test(p)) n = parseInt(p, 8);
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null; // e.g. bare hex without 0x — not an inet_aton form
    if (isNaN(n)) return null;
    nums.push(n);
  }

  // inet_aton semantics: the last part fills all remaining bytes
  var lastBytes = 5 - nums.length;
  if (nums[nums.length - 1] >= Math.pow(256, lastBytes)) return null;
  for (var j = 0; j < nums.length - 1; j++) {
    if (nums[j] > 255) return null;
  }

  var ip = 0;
  for (var k = 0; k < nums.length - 1; k++) {
    ip = ip * 256 + nums[k];
  }
  return ip * Math.pow(256, lastBytes) + nums[nums.length - 1];
}

/**
 * Whether a 32-bit IPv4 address is publicly routable (not loopback,
 * private, link-local/metadata, CGNAT, multicast, or reserved).
 */
function isPublicIpv4(ip) {
  var b0 = Math.floor(ip / 16777216) % 256;
  var b1 = Math.floor(ip / 65536) % 256;
  if (b0 === 0 || b0 === 10 || b0 === 127) return false;
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return false;  // CGNAT
  if (b0 === 169 && b1 === 254) return false;             // link-local + cloud metadata
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return false;
  if (b0 === 192 && b1 === 168) return false;
  if (b0 >= 224) return false;                            // multicast/reserved/broadcast
  return true;
}

/**
 * Validates that a URL is safe to fetch server-side.
 * Blocks private/internal IPs (in dotted, decimal, octal, and hex forms),
 * IPv6 literals, cloud metadata hosts, and non-HTTPS protocols.
 *
 * @param {string} url - URL to validate
 * @returns {boolean} True if safe to fetch
 */
function isSafeUrl(url) {
  if (!url) return false;
  // Only allow HTTPS
  if (!/^https:\/\//i.test(url)) return false;
  // Extract host (may include credentials/port — strip both)
  var hostMatch = url.match(/^https:\/\/([^/?#]+)/i);
  if (!hostMatch) return false;
  var host = hostMatch[1].toLowerCase();
  var at = host.lastIndexOf('@');
  if (at !== -1) host = host.slice(at + 1);
  // IPv6 literals — no legitimate article lives at one
  if (host.indexOf('[') !== -1 || host.indexOf(']') !== -1) return false;
  var colon = host.indexOf(':');
  if (colon !== -1) host = host.slice(0, colon);
  host = host.replace(/\.$/, ''); // "127.0.0.1." is a valid FQDN spelling
  if (!host) return false;

  if (host === 'localhost' || /\.localhost$/.test(host) || /\.local$/.test(host)) return false;
  if (/^metadata\.google/.test(host) || host === 'metadata.google.internal') return false;

  // Numeric hosts: normalize every inet_aton spelling to one 32-bit
  // address before range-checking — 0x7f000001, 2130706433, and
  // 017700000001 are all 127.0.0.1.
  var ip = parseIpv4(host);
  if (ip !== null) return isPublicIpv4(ip);

  return true;
}

function fetchOgImage(articleUrl) {
  if (!articleUrl) return '';

  // Follow redirects MANUALLY so every hop is re-validated. With
  // followRedirects:true only the first URL was checked — a malicious
  // or compromised feed could 302 the fetch into internal addresses.
  var url = articleUrl;
  var response = null;
  var maxHops = 4;
  try {
    for (var hop = 0; hop <= maxHops; hop++) {
      if (!isSafeUrl(url)) return '';
      response = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        followRedirects: false,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      });

      var code = response.getResponseCode();
      if (code >= 300 && code < 400) {
        var headers = response.getAllHeaders();
        var location = headers['Location'] || headers['location'] || '';
        if (Array.isArray(location)) location = location[0] || '';
        if (!location) return '';
        if (/^https:\/\//i.test(location)) {
          url = location;
        } else if (location.charAt(0) === '/' && location.charAt(1) !== '/') {
          var origin = url.match(/^https:\/\/[^/?#]+/i);
          if (!origin) return '';
          url = origin[0] + location;
        } else {
          // http:// downgrade, protocol-relative, or exotic form — give up
          return '';
        }
        continue;
      }
      break;
    }
    if (!response || response.getResponseCode() !== 200) return '';

    var html = response.getContentText().substring(0, 50000); // Only scan first 50KB

    // og:image (both attribute orders)
    var ogMatch = html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
                || html.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
    if (ogMatch) return ogMatch[1];

    // twitter:image
    var twMatch = html.match(/name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i)
               || html.match(/content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i);
    if (twMatch) return twMatch[1];

    // Last resort: first large image on the page
    return extractImageFromHtml(html);
  } catch (e) {
    return '';
  }
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
    log('WARN', 'parseRssFeed', 'XML parse failed for ' + channelName + ': ' + e.message + '. Falling back to regex.');
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
    var title = decodeHtmlEntities(item.getChildText('title') || '');
    var link = item.getChildText('link') || '';
    var pubDate = item.getChildText('pubDate') || new Date().toISOString();
    var guid = item.getChildText('guid') || link;
    
    var videoId = extractYouTubeId(link);
    var mediaType = videoId ? 'video' : 'article';
    // Use MD5 hash to guarantee uniqueness even if URLs share identical suffixes
    var hashBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, guid);
    var itemId = videoId || Utilities.base64EncodeWebSafe(hashBytes).replace(/[^a-zA-Z0-9]/g, '').slice(0, 15);
    
    var previewImage = '';
    // 1. Try media:content
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
    // 2. Try enclosure
    if (!previewImage) {
      var enclosure = item.getChild('enclosure');
      if (enclosure && enclosure.getAttribute('type') && enclosure.getAttribute('type').getValue().indexOf('image') > -1) {
        previewImage = enclosure.getAttribute('url').getValue();
      }
      // Some feeds use enclosure without type for images
      if (!previewImage && enclosure && enclosure.getAttribute('url')) {
        var encUrl = enclosure.getAttribute('url').getValue();
        if (/\.(jpg|jpeg|png|webp|gif)/i.test(encUrl)) {
          previewImage = encUrl;
        }
      }
    }
    // 3. Extract from description + content:encoded using smart helper
    if (!previewImage) {
      var desc = item.getChildText('description') || '';
      var contentEncoded = contentNs ? item.getChildText('encoded', contentNs) || '' : '';
      previewImage = extractImageFromHtml(contentEncoded + ' ' + desc);
    }
    // 4. Last resort for articles: fetch the article page for og:image
    if (!previewImage && mediaType === 'article' && link) {
      previewImage = fetchOgImage(link);
    }
    
    videos.push({
      video_id: itemId,
      media_type: mediaType,
      channel_name: channelName,
      title: title,
      url: link,
      preview_image: previewImage,
      published_at: toIsoDate(pubDate),
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
    var title = decodeHtmlEntities(entry.getChildText('title', ns) || '');
    
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
    var hashBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, link);
    var itemId = ytVideoId || Utilities.base64EncodeWebSafe(hashBytes).replace(/[^a-zA-Z0-9]/g, '').slice(0, 15);
    
    var previewImage = '';
    var viewCount = 0;
    // 1. media:group > media:thumbnail (YouTube); media:community carries view counts
    if (mediaNs) {
      var mediaGroup = entry.getChild('group', mediaNs);
      if (mediaGroup) {
        var mediaThumbnail = mediaGroup.getChild('thumbnail', mediaNs);
        if (mediaThumbnail && mediaThumbnail.getAttribute('url')) {
          previewImage = mediaThumbnail.getAttribute('url').getValue();
        }
        var mediaCommunity = mediaGroup.getChild('community', mediaNs);
        if (mediaCommunity) {
          var mediaStats = mediaCommunity.getChild('statistics', mediaNs);
          if (mediaStats && mediaStats.getAttribute('views')) {
            viewCount = parseInt(mediaStats.getAttribute('views').getValue(), 10) || 0;
          }
        }
      }
    }
    // 2. Extract from content/summary using smart helper
    if (!previewImage) {
      var content = entry.getChildText('content', ns) || entry.getChildText('summary', ns) || '';
      previewImage = extractImageFromHtml(content);
    }
    // 3. Last resort for articles: fetch og:image
    if (!previewImage && mediaType === 'article' && link) {
      previewImage = fetchOgImage(link);
    }
    
    videos.push({
      video_id: itemId,
      media_type: mediaType,
      channel_name: channelName,
      title: title,
      url: link,
      preview_image: previewImage,
      published_at: toIsoDate(published),
      tier: tier,
      category: category,
      view_count: viewCount,
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
    
    var title = decodeHtmlEntities(titleMatch[1].trim());
    var link = linkMatch[1].trim();
    var pubDate = pubDateMatch ? pubDateMatch[1].trim() : new Date().toISOString();
    
    var videoId = extractYouTubeId(link);
    var mediaType = videoId ? 'video' : 'article';
    var hashBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, link);
    var itemId = videoId || Utilities.base64EncodeWebSafe(hashBytes).replace(/[^a-zA-Z0-9]/g, '').slice(0, 15);
    
    var previewImage = '';
    // 1. Try media tags
    var imgMatch = itemXml.match(/<media:content[^>]+url="([^">]+)"/i) || itemXml.match(/<media:thumbnail[^>]+url="([^">]+)"/i);
    if (imgMatch) previewImage = imgMatch[1];
    // 2. Smart HTML extraction
    if (!previewImage) previewImage = extractImageFromHtml(itemXml);
    // 3. og:image fallback for articles
    if (!previewImage && mediaType === 'article' && link) {
      previewImage = fetchOgImage(link);
    }
    
    videos.push({
      video_id: itemId,
      media_type: mediaType,
      channel_name: channelName,
      title: title,
      url: link,
      preview_image: previewImage,
      published_at: toIsoDate(pubDate),
      tier: tier,
      category: category,
    });
  }
  return videos;
}

// ============================================================
// VIDEOS
// ============================================================

/**
 * Reads and normalizes every row from the Videos sheet.
 * Shared by getVideos (paginated feed) and handleTopWeek (weekly ranking).
 * @returns {Object[]} Normalized video objects (unsorted)
 */
function readAllVideos() {
  var sheet = getSheet('VIDEOS');
  var data = sheet.getDataRange().getValues();

  if (data.length <= 1) return [];

  var headers = data[0];
  var videos = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var video = {};
    for (var j = 0; j < headers.length; j++) {
      video[headers[j]] = row[j];
    }

    // Legacy fallback: if media_type column is missing from older sheet data,
    // infer type from video_id length. YouTube IDs are always exactly 11 chars;
    // article IDs are base64-encoded URLs (much longer).
    if (!video.media_type) {
      video.media_type = (video.video_id && video.video_id.length === 11) ? 'video' : 'article';
    }

    // Normalize counts to integers (columns may be absent or blank)
    video.vote_count = Number(video.vote_count) || 0;
    video.view_count = Number(video.view_count) || 0;

    videos.push(video);
  }

  return dedupeByUrl(videos);
}

/** Engagement weight for dedupe tiebreaks: votes dominate, comments break ties. */
function videoEngagement(v) {
  return (Number(v.vote_count) || 0) * 1000 + (Number(v.comment_count) || 0);
}

/**
 * Collapses rows that point at the same URL down to a single entry.
 *
 * Article IDs were derived two different ways over the project's life (base64
 * of the URL string, then base64 of an MD5 hash of the guid). The pre-change
 * rows were orphaned: re-crawls no longer matched them by id, so crawlAllFeeds
 * appended every still-in-feed article a second time under its new id. Both
 * rows carry the same url, so we key on that and keep the most-engaged copy
 * (votes first, then comments) — the row users have actually voted/commented
 * on. YouTube items are unaffected (their id is the stable YouTube id) and
 * rows without a url fall back to their id so distinct items never merge.
 *
 * This corrects the served feed, the total count, and pagination without
 * touching the sheet. (crawlAllFeeds won't re-double: the new-scheme id now
 * exists, so future crawls dedupe against it.)
 */
function dedupeByUrl(videos) {
  var byKey = {};
  var order = [];
  for (var i = 0; i < videos.length; i++) {
    var v = videos[i];
    var key = v.url ? String(v.url).trim().toLowerCase() : 'id:' + v.video_id;
    if (!byKey.hasOwnProperty(key)) {
      byKey[key] = v;
      order.push(key);
    } else if (videoEngagement(v) > videoEngagement(byKey[key])) {
      byKey[key] = v;
    }
  }
  return order.map(function(k) { return byKey[k]; });
}

/** Millisecond publish time for sorting/cursoring; invalid dates sort oldest. */
function pubTime(video) {
  var t = new Date(video.published_at).getTime();
  return isNaN(t) ? 0 : t;
}

/**
 * Total order for the feed: published_at descending, video_id descending
 * as the tiebreak. Deterministic so cursor pagination never skips or
 * repeats items whose timestamps collide.
 */
function compareVideos(a, b) {
  var diff = pubTime(b) - pubTime(a);
  if (diff !== 0) return diff;
  var aId = String(a.video_id || '');
  var bId = String(b.video_id || '');
  return aId < bId ? 1 : (aId > bId ? -1 : 0);
}

/** Opaque pagination cursor for the position AFTER this video. */
function cursorFor(video) {
  return new Date(pubTime(video)).toISOString() + '|' + video.video_id;
}

function getVideos(page, limit, cursor) {
  var videos = readAllVideos();

  if (videos.length === 0) {
    return { status: 'ok', videos: [], total: 0, page: page, next_cursor: '' };
  }

  // Sort by published_at descending (newest first), video_id tiebreak
  videos.sort(compareVideos);

  var start = (page - 1) * limit;

  // Cursor pagination: resume strictly after the (published_at, video_id)
  // position the client last saw. Unlike the page offset above, items
  // prepended by a feed ingest mid-session can't shift this window —
  // offset pages made forward scrolling skip (or repeat) shifted items.
  if (cursor) {
    var sep = cursor.indexOf('|');
    var cursorTime = new Date(sep === -1 ? cursor : cursor.slice(0, sep)).getTime();
    var cursorId = sep === -1 ? '' : String(cursor.slice(sep + 1));
    if (!isNaN(cursorTime)) {
      start = 0;
      while (start < videos.length) {
        var t = pubTime(videos[start]);
        if (t < cursorTime || (t === cursorTime && String(videos[start].video_id || '') < cursorId)) break;
        start++;
      }
    }
  }

  var paged = videos.slice(start, start + limit);

  return {
    status: 'ok',
    videos: paged,
    total: videos.length,
    page: page,
    // Where the next request should resume; '' when the catalog is done
    next_cursor: (paged.length > 0 && start + paged.length < videos.length)
      ? cursorFor(paged[paged.length - 1])
      : '',
  };
}

/**
 * Returns videos published in the last 7 days, ranked by upvotes
 * (most-voted first, newest as the tiebreak). When votes are sparse
 * this gracefully degrades to the week's videos in reverse-chron order,
 * so the tab is never empty.
 */
function handleTopWeek(params) {
  // Read-only by design. The Videos sheet is kept fresh by the feed request
  // (handleFeed refreshes when stale) and the scheduled trigger — so this
  // request just reads and ranks. Crawling RSS here (fetchAllFeeds, ~0.5s per
  // channel plus retry backoff) made the request slow enough to time out, and
  // unlike the feed the top-week tab has no cached fallback, so a slow crawl
  // surfaced to the user as an outright failure.
  var limit = parseInt(params.limit) || 50;
  var cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

  var recent = readAllVideos().filter(function(v) {
    var t = new Date(v.published_at).getTime();
    return !isNaN(t) && t >= cutoff;
  });

  recent.sort(function(a, b) {
    if (b.vote_count !== a.vote_count) return b.vote_count - a.vote_count;
    return new Date(b.published_at) - new Date(a.published_at);
  });

  return {
    status: 'ok',
    videos: recent.slice(0, limit),
    total: recent.length,
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
  var videoIdCol = findVideoIdCol(headers);
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

/**
 * Returns comments for multiple videos in a single execution.
 * One sheet read serves the whole batch, so prefetching N cards
 * costs 1 web app execution instead of N.
 *
 * @param {Object} params - { videoIds: 'id1,id2,...' } (max 20 ids)
 * @returns {Object} { status: 'ok', byVideo: { videoId: [comments] } }
 */
function handleCommentsBatch(params) {
  var raw = params.videoIds || '';
  var ids = raw.split(',').filter(function(id) { return id; }).slice(0, 20);

  if (ids.length === 0) {
    return { status: 'error', message: 'videoIds is required' };
  }

  var byVideo = {};
  ids.forEach(function(id) { byVideo[id] = []; });

  var sheet = getSheet('COMMENTS');
  var data = sheet.getDataRange().getValues();

  if (data.length > 1) {
    var headers = data[0];
    var videoIdCol = findVideoIdCol(headers);

    for (var i = 1; i < data.length; i++) {
      var vid = data[i][videoIdCol];
      if (!byVideo[vid]) continue;

      var comment = {};
      for (var j = 0; j < headers.length; j++) {
        comment[headers[j]] = data[i][j];
      }
      byVideo[vid].push(comment);
    }

    // Sort each video's comments by created_at ascending (oldest first for threading)
    ids.forEach(function(id) {
      byVideo[id].sort(function(a, b) {
        return new Date(a.created_at) - new Date(b.created_at);
      });
    });
  }

  return { status: 'ok', byVideo: byVideo };
}

function handleAddComment(data) {
  var videoId = data.videoId;
  var parentId = data.parentId;
  var body = data.body;
  var token = data.token;

  // 1. Validate required fields
  if (!videoId || !body || !token) {
    return { status: 'error', message: 'videoId, body, and token are required' };
  }

  // 2. Validate comment length (max 2000 characters)
  if (body.length > 2000) {
    return { status: 'error', message: 'Comment too long (max 2000 characters)' };
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

  // 5. Determine depth
  var depth = 0;
  if (parentId) {
    depth = 1;
  }

  // 6. Generate comment ID
  var commentId = 'c_' + Utilities.getUuid().replace(/-/g, '').substring(0, 12);

  // Serialize the rate-limit check + append + recount. The rate limit is
  // checked INSIDE the lock: two simultaneous posts otherwise both read a
  // stale last-comment time, both pass the 30s check, and both post.
  // updateCommentCount also re-reads the whole Comments sheet to total this
  // video's comments; without a lock, two simultaneous posts on the same
  // video race and the second recount can overwrite comment_count with a
  // stale total (lost update), so the stored count drifts permanently below
  // the real number. Mirrors handleVote/handleStar.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return { status: 'error', message: 'Server busy, please retry' };
  }

  try {
    // 7. Check rate limit (see lock comment above)
    if (isRateLimited(user.email)) {
      log('WARN', 'addComment', 'Rate limited: ' + user.email);
      return { status: 'error', message: 'Please wait before posting another comment' };
    }

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
  } finally {
    lock.releaseLock();
  }

  log('INFO', 'addComment', 'Comment added by ' + user.email + ' on video ' + videoId);

  return { status: 'ok', comment_id: commentId };
}

function updateCommentCount(videoId) {
  // Count comments for this video
  var commentsSheet = getSheet('COMMENTS');
  var commentsData = commentsSheet.getDataRange().getValues();
  var headers = commentsData[0];
  var videoIdCol = findVideoIdCol(headers);
  var count = 0;

  for (var i = 1; i < commentsData.length; i++) {
    if (commentsData[i][videoIdCol] === videoId) count++;
  }

  // Update the video row
  var videosSheet = getSheet('VIDEOS');
  var videosData = videosSheet.getDataRange().getValues();
  var vHeaders = videosData[0];
  var vVideoIdCol = findVideoIdCol(vHeaders);
  var commentCountCol = vHeaders.indexOf('comment_count');

  for (var i = 1; i < videosData.length; i++) {
    if (videosData[i][vVideoIdCol] === videoId) {
      videosSheet.getRange(i + 1, commentCountCol + 1).setValue(count);
      break;
    }
  }
}

// ============================================================
// VOTES — Reddit-style upvotes, one per Google account per video
// ============================================================

/**
 * Gets (or creates) the "Votes" tab inside the Comments spreadsheet.
 * Storing it as a named tab avoids provisioning a separate spreadsheet.
 * @returns {Sheet}
 */
function getVotesSheet() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_IDS.COMMENTS);
  var sheet = ss.getSheetByName('Votes');
  if (!sheet) {
    sheet = ss.insertSheet('Votes');
    sheet.appendRow(['vote_id', 'video_id', 'user_email', 'created_at']);
  }
  return sheet;
}

/**
 * Toggles a user's upvote on a video.
 * If the user has already voted, the vote is removed (toggle off).
 */
function handleVote(data) {
  var videoId = data.videoId;
  var token = data.token;

  if (!videoId || !token) {
    return { status: 'error', message: 'videoId and token are required' };
  }

  var user = verifyGoogleToken(token);
  if (!user) {
    log('ERROR', 'vote', 'Invalid Google token');
    return { status: 'error', message: 'Invalid authentication token' };
  }

  if (isUserBlocked(user.email)) {
    return { status: 'error', message: 'You have been blocked' };
  }

  // Serialize the read-find-mutate-recount so concurrent toggles from the
  // same user can't double-insert or delete the wrong (shifted) row.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return { status: 'error', message: 'Server busy, please retry' };
  }

  try {
    var sheet = getVotesSheet();
    var data2 = sheet.getDataRange().getValues();
    var headers = data2[0];
    var videoIdCol = headers.indexOf('video_id');
    var emailCol = headers.indexOf('user_email');

    // Find this user's existing vote on this video
    var existingRow = -1;
    for (var i = 1; i < data2.length; i++) {
      if (data2[i][videoIdCol] === videoId && data2[i][emailCol] === user.email) {
        existingRow = i + 1; // 1-based sheet row
        break;
      }
    }

    var voted;
    if (existingRow !== -1) {
      sheet.deleteRow(existingRow);
      voted = false;
    } else {
      var voteId = 'v_' + Utilities.getUuid().replace(/-/g, '').substring(0, 12);
      sheet.appendRow([voteId, videoId, user.email, new Date().toISOString()]);
      voted = true;
    }

    var count = updateVoteCount(videoId);
    return { status: 'ok', voted: voted, vote_count: count };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Returns the list of video IDs the signed-in user has upvoted,
 * so the client can mark its buttons as already-voted.
 */
function handleMyVotes(data) {
  var token = data.token;
  if (!token) {
    return { status: 'error', message: 'token is required' };
  }

  var user = verifyGoogleToken(token);
  if (!user) {
    return { status: 'error', message: 'Invalid authentication token' };
  }

  var sheet = getVotesSheet();
  var rows = sheet.getDataRange().getValues();
  var headers = rows[0];
  var videoIdCol = headers.indexOf('video_id');
  var emailCol = headers.indexOf('user_email');

  var ids = [];
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][emailCol] === user.email) ids.push(rows[i][videoIdCol]);
  }

  return { status: 'ok', video_ids: ids };
}

/**
 * Recounts votes for a video from the Votes sheet and writes the total
 * to the video's vote_count column, creating that column if it's missing.
 * @returns {number} The new vote count
 */
function updateVoteCount(videoId) {
  var votesSheet = getVotesSheet();
  var votesData = votesSheet.getDataRange().getValues();
  var vHeaders = votesData[0];
  var voteVideoCol = vHeaders.indexOf('video_id');
  var count = 0;
  for (var i = 1; i < votesData.length; i++) {
    if (votesData[i][voteVideoCol] === videoId) count++;
  }

  var videosSheet = getSheet('VIDEOS');
  var videosData = videosSheet.getDataRange().getValues();
  var headers = videosData[0];
  var videoIdCol = findVideoIdCol(headers);
  var voteCountCol = headers.indexOf('vote_count');

  // Self-initialize: add the vote_count column if the sheet predates voting
  if (voteCountCol === -1) {
    voteCountCol = headers.length;
    videosSheet.getRange(1, voteCountCol + 1).setValue('vote_count');
  }

  for (var i = 1; i < videosData.length; i++) {
    if (videosData[i][videoIdCol] === videoId) {
      videosSheet.getRange(i + 1, voteCountCol + 1).setValue(count);
      break;
    }
  }

  return count;
}

// ============================================================
// STARS — starred creators, one per Google account per channel
// ============================================================

/**
 * Gets (or creates) the "Stars" tab inside the Comments spreadsheet,
 * following the same pattern as the Votes tab.
 * @returns {Sheet}
 */
function getStarsSheet() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_IDS.COMMENTS);
  var sheet = ss.getSheetByName('Stars');
  if (!sheet) {
    sheet = ss.insertSheet('Stars');
    sheet.appendRow(['star_id', 'channel_name', 'user_email', 'created_at']);
  }
  return sheet;
}

/**
 * Toggles a user's star on a creator (channel).
 * If the user has already starred the channel, the star is removed.
 */
function handleStar(data) {
  var channel = data.channel;
  var token = data.token;

  if (!channel || !token) {
    return { status: 'error', message: 'channel and token are required' };
  }

  var user = verifyGoogleToken(token);
  if (!user) {
    log('ERROR', 'star', 'Invalid Google token');
    return { status: 'error', message: 'Invalid authentication token' };
  }

  if (isUserBlocked(user.email)) {
    return { status: 'error', message: 'You have been blocked' };
  }

  // Serialize read-find-mutate so concurrent toggles can't double-insert
  // or delete a row that shifted under a stale index.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return { status: 'error', message: 'Server busy, please retry' };
  }

  try {
    var sheet = getStarsSheet();
    var rows = sheet.getDataRange().getValues();
    var headers = rows[0];
    var channelCol = headers.indexOf('channel_name');
    var emailCol = headers.indexOf('user_email');

    // Find this user's existing star on this channel. Compare as strings so
    // a numeric/date-like channel name (Sheets type coercion) still matches.
    var existingRow = -1;
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][channelCol]) === channel && rows[i][emailCol] === user.email) {
        existingRow = i + 1; // 1-based sheet row
        break;
      }
    }

    var starred;
    if (existingRow !== -1) {
      sheet.deleteRow(existingRow);
      starred = false;
    } else {
      // Write as plain text so Sheets can't coerce a numeric-looking channel
      var starId = 's_' + Utilities.getUuid().replace(/-/g, '').substring(0, 12);
      var newRowNum = sheet.getLastRow() + 1;
      var range = sheet.getRange(newRowNum, 1, 1, 4);
      range.setNumberFormat('@');
      range.setValues([[starId, channel, user.email, new Date().toISOString()]]);
      starred = true;
    }

    return { status: 'ok', starred: starred };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Returns the channel names the signed-in user has starred,
 * so the client can mark star buttons and build the Starred feed.
 */
function handleMyStars(data) {
  var token = data.token;
  if (!token) {
    return { status: 'error', message: 'token is required' };
  }

  var user = verifyGoogleToken(token);
  if (!user) {
    return { status: 'error', message: 'Invalid authentication token' };
  }

  var sheet = getStarsSheet();
  var rows = sheet.getDataRange().getValues();
  var headers = rows[0];
  var channelCol = headers.indexOf('channel_name');
  var emailCol = headers.indexOf('user_email');

  var channels = [];
  for (var i = 1; i < rows.length; i++) {
    // Coerce to string so numeric/date-like channel names round-trip intact
    var ch = String(rows[i][channelCol]);
    if (rows[i][emailCol] === user.email && channels.indexOf(ch) === -1) {
      channels.push(ch);
    }
  }

  return { status: 'ok', channels: channels };
}

// ============================================================
// AUTHENTICATION
// ============================================================

/**
 * Verifies a Google ID token using Google's tokeninfo endpoint.
 * 
 * NOTE: The `tokeninfo` endpoint is simple but has limitations:
 * - It makes a network call per verification (adds latency)
 * - Google recommends using a JWT library for production
 *   (Apps Script lacks native JWT verification support)
 * - Token is validated for structure + expiry by Google's servers
 */
function verifyGoogleToken(idToken) {
  try {
    var response = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true }
    );

    if (response.getResponseCode() !== 200) {
      return null;
    }

    var payload = JSON.parse(response.getContentText());

    // tokeninfo confirms the token is a valid, unexpired, Google-signed ID
    // token — but it returns 200 for a token minted for ANY OAuth client.
    // Without the audience check below, a token issued to any other Google
    // Sign-In site could be replayed here to act as its owner. Verify
    // audience, issuer, expiry, and a verified email before trusting it.
    if (payload.aud !== GOOGLE_CLIENT_ID) {
      log('ERROR', 'verifyGoogleToken', 'Token audience mismatch');
      return null;
    }
    if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
      log('ERROR', 'verifyGoogleToken', 'Token issuer invalid: ' + payload.iss);
      return null;
    }
    if (!payload.exp || parseInt(payload.exp, 10) * 1000 <= Date.now()) {
      log('ERROR', 'verifyGoogleToken', 'Token expired');
      return null;
    }
    if (!payload.email || String(payload.email_verified) !== 'true') {
      log('ERROR', 'verifyGoogleToken', 'Email not present or not verified');
      return null;
    }

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

// Read-modify-write with no lock of its own: callers that can race on the
// SAME key must serialize around it (rate stamps run inside the
// handleAddComment lock; last_fetch / fetch_in_progress are single-writer
// via the fetchAllFeeds guard). LockService is not reentrant, so taking
// the script lock here would deadlock those callers.
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
  // Require admin token from Meta sheet. Fail CLOSED when it isn't
  // configured — logs carry user emails, and an unset token must mean
  // "nobody gets in", not "everybody does".
  var adminToken = getMeta('admin_token');
  if (!adminToken || params.token !== adminToken) {
    return { status: 'error', message: 'Unauthorized' };
  }

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
