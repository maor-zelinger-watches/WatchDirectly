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

// Backend version (npm semver) — bump on every deployed change. Stamped into
// every JSON response and served via ?action=version, so the live deployment
// is always identifiable. The frontend has its own APP_VERSION in
// js/config.js; see CHANGELOG.md at the repo root.
const VERSION = '1.9.0';

const DEFAULT_REFRESH_HOURS = 4;
const DEFAULT_PAGE_LIMIT = 20;

// Feed-head cache: the first FEED_HEAD_COUNT sorted videos are kept in
// CacheService so the requests that gate first paint (page 1, the page-1
// completion, early prefetch pages) skip the full Videos-sheet scan + sort —
// the dominant cost of a feed doGet. Short TTL as a backstop; the cache is
// explicitly invalidated by every writer that changes what the head contains
// (crawl completions, vote recounts, comment recounts). ~50 rows is ~50KB,
// comfortably inside CacheService's 100KB/key limit.
const FEED_HEAD_COUNT = 50;
const FEED_HEAD_CACHE_KEY = 'feed_head_v1';
const FEED_HEAD_CACHE_SECONDS = 300;

// Top-This-Week cache: the ranked last-7-days window is kept in CacheService so
// repeat opens of the tab skip the full Videos-sheet scan + sort — the same
// dominant cost the feed head avoids. handleTopWeek is read-only and has no
// cached fallback, so a cold scan of an ever-growing sheet is exactly the cost
// that once timed the request out. Invalidated by every writer that changes the
// ranking (crawl completions add rows; vote/comment recounts change the counts
// baked into the cached rows). The window rarely exceeds a few dozen items; cap
// the stored slice well inside CacheService's 100KB/key limit and fall through
// to a live scan for the rare request that asks for more than the cap.
const TOP_WEEK_CACHE_COUNT = 50;
const TOP_WEEK_CACHE_KEY = 'top_week_v1';
const TOP_WEEK_CACHE_SECONDS = 300;
const RATE_LIMIT_SECONDS = 30; // Min seconds between comments per user

// Grace window applied to a premiere/live entry's expiry. A scheduled premiere
// that never airs, or a stream that never ends, stops being surfaced once its
// scheduled start (or, if unknown, its ingest time) is this far in the past.
const LIVE_GRACE_MS = 12 * 60 * 60 * 1000;

// Videos older than this are moved out of the live Videos sheet into an
// "Archive" tab at the end of each crawl. readAllVideos scans and sorts the
// WHOLE live sheet on every cache miss, so an ever-growing catalog is the one
// cost that eventually times a request out against Apps Script's 6-min cap;
// pruning keeps that scan bounded. The window is far larger than any channel's
// ~15-entry RSS feed reaches, so an archived item is never re-fetched and
// re-appended, and the feed head, Top-This-Week, and starred feeds all live
// comfortably inside it. Archived rows are retained (not deleted), just no
// longer scanned.
const PRUNE_AFTER_DAYS = 60;
const ARCHIVE_SHEET_NAME = 'Archive';

// OAuth client ID this app's Google Sign-In tokens are minted for. Every ID
// token MUST carry this as its `aud` claim, or it was issued to a different
// site and must be rejected — Google's tokeninfo endpoint validates the token
// signature and expiry but NOT the audience. Keep in sync with GOOGLE_CLIENT_ID
// in js/app.js.
const GOOGLE_CLIENT_ID = '58088759188-uhqgajeoe8h218h3o6pql634pkcjsu70.apps.googleusercontent.com';

// App-issued session tokens. After the first Google Sign-In we verify the
// Google ID token ONCE, then mint our own HMAC-signed token the client reuses
// for ~SESSION_TTL_DAYS. This lets the frontend re-authenticate silently (a
// plain fetch to ?action=session) instead of re-invoking Google One Tap — no
// visible overlay when a returning visitor opens the site. The token is opaque
// bearer material; SESSION_TOKEN_PREFIX lets authenticateUser tell an app token
// from a Google JWT without decoding it.
const SESSION_TTL_DAYS = 30;
const SESSION_TOKEN_PREFIX = 'wds1.';

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

// Cache per execution
let _cachedLogLevel = null;
let _cachedSessionSecret = null;


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
      case 'getChannels':
        return jsonResponse(handleGetChannels());
      case 'refresh':
        // Side-effectful: kicks off a full crawl that spends UrlFetch and
        // YouTube Data API quota. Admin-only — the scheduled trigger and the
        // stale-feed auto-refresh cover the routine case; this is a manual
        // override, not an endpoint anonymous callers may spin.
        if (!isAdmin(e.parameter.token)) {
          return jsonResponse({ status: 'error', message: 'Unauthorized' });
        }
        return jsonResponse(handleRefresh());
      case 'version':
        return jsonResponse({ status: 'ok' });
      default:
        return jsonResponse({ status: 'error', message: 'Unknown action: ' + action });
    }
  } catch (error) {
    log('ERROR', 'doGet', error.message);
    // Generic message to the client — the detail is in the log, not the wire.
    return jsonResponse({ status: 'error', message: 'Request failed. Please try again.' });
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
      case 'bootstrap':
        return jsonResponse(handleBootstrap(data));
      case 'session':
        return jsonResponse(handleSession(data));
      case 'logs':
        // Admin-only, over POST so the token never lands in a URL/query log.
        if (!isAdmin(data.token)) {
          return jsonResponse({ status: 'error', message: 'Unauthorized' });
        }
        return jsonResponse(handleLogs(data));
      default:
        return jsonResponse({ status: 'error', message: 'Unknown action: ' + action });
    }
  } catch (error) {
    log('ERROR', 'doPost', error.message);
    // Generic message to the client — the detail is in the log, not the wire.
    return jsonResponse({ status: 'error', message: 'Request failed. Please try again.' });
  }
}

/**
 * Constant-time check that `token` matches the admin token stored in Meta.
 * Fails CLOSED when no admin token is configured — an unset token must mean
 * "nobody gets in", never "everybody does". Used to gate the side-effectful
 * refresh endpoint and the log reader, both of which are operator-only.
 *
 * @param {string} token
 * @returns {boolean}
 */
function isAdmin(token) {
  var adminToken = getMeta('admin_token');
  if (!adminToken || !token) return false;
  return constantTimeEquals(String(token), String(adminToken));
}

function jsonResponse(data) {
  // Every response carries the deployed backend version, so any client (or
  // a plain curl) can tell which deployment answered.
  if (data && typeof data === 'object' && !('version' in data)) {
    data.version = VERSION;
  }
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

// A feed request NEVER crawls inline. fetchAllFeeds crawls ~14 RSS feeds with
// a per-channel sleep, exponential-backoff retries, and YouTube API enrichment
// — a job measured in tens of seconds. Apps Script serializes a single user's
// web requests, so running that crawl here stalled EVERY other request the page
// fired on load (feed pages, votes, stars) behind it for the crawl's full
// duration — the client saw 30s+ TTFBs while the execution itself was fast.
// Instead we always serve the current sheet immediately and, when the data is
// stale, hand the crawl to its own execution via a one-shot trigger.
// handleTopWeek learned this same lesson (it never crawls either).
function handleFeed(params) {
  var lastFetch = getMeta('last_fetch');
  var refreshHours = parseInt(getMeta('refresh_interval_hours')) || DEFAULT_REFRESH_HOURS;
  var staleThreshold = refreshHours * 60 * 60 * 1000;
  var stale = !lastFetch || (Date.now() - new Date(lastFetch).getTime()) > staleThreshold;

  if (stale) {
    scheduleRefresh();
  }

  var page = parseInt(params.page) || 1;
  var limit = parseInt(params.limit) || DEFAULT_PAGE_LIMIT;

  var result = getVideos(page, limit, params.cursor || '');
  // Signal that an async refresh is underway; the client keeps serving cache.
  if (stale) result.stale = true;
  return result;
}

/**
 * Schedules an asynchronous feed refresh on its own execution, so a stale-feed
 * web request can return immediately instead of blocking on the crawl.
 *
 * A one-shot time-based trigger (fires ~1s out) runs kickoffRefresh in a
 * separate invocation. Guarded against pile-up: skip if a crawl is already
 * running (fetch_in_progress marker) or a kickoffRefresh trigger is already
 * pending. The check-and-create runs under the script lock so two concurrent
 * stale requests can't both install a trigger; if the lock is contended we
 * simply skip — the next feed request (or the 4h trigger) will reschedule, and
 * feed staleness is never urgent.
 */
function scheduleRefresh() {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(3000);
  } catch (e) {
    return;
  }
  try {
    var inProgress = getMeta('fetch_in_progress');
    if (inProgress && (Date.now() - new Date(inProgress).getTime()) < 10 * 60 * 1000) {
      return; // a crawl is already running — another would just no-op
    }
    if (hasPendingTrigger('kickoffRefresh')) {
      return; // one pending refresh is enough
    }
    ScriptApp.newTrigger('kickoffRefresh').timeBased().after(1000).create();
    log('INFO', 'scheduleRefresh', 'Async refresh scheduled');
  } catch (e) {
    log('ERROR', 'scheduleRefresh', e.message);
  } finally {
    lock.releaseLock();
  }
}

/** True if a project trigger for the given handler function already exists. */
function hasPendingTrigger(handlerName) {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === handlerName) return true;
  }
  return false;
}

/**
 * Entry point for the one-shot refresh trigger installed by scheduleRefresh.
 * A one-shot trigger does NOT remove itself once fired, so we delete every
 * kickoffRefresh trigger first (left to accumulate they'd hit the 20-trigger
 * project cap), then run the crawl. fetchAllFeeds has its own in-progress guard.
 */
function kickoffRefresh() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'kickoffRefresh') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  fetchAllFeeds();
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

/**
 * Extracts the registrable host from a URL for use as a favicon lookup key
 * (e.g. 'https://www.wornandwound.com/article1' -> 'wornandwound.com').
 * Strips a leading 'www.' so the favicon service gets the bare domain.
 * @param {string} url
 * @returns {string} Hostname, or '' if the URL can't be parsed.
 */
function extractDomain(url) {
  if (!url) return '';
  var match = String(url).match(/^https?:\/\/([^/?#]+)/i);
  if (!match) return '';
  return match[1].replace(/^www\./i, '');
}

/**
 * Serves the curated creator list (name, host, url, avatar, etc.) from the
 * CHANNELS sheet for the frontend's Channels tab and search host-matching —
 * the same sheet crawlAllFeeds reads to know which feeds to poll. Disabled
 * channels are omitted so a paused feed doesn't still show up as browsable.
 *
 * News/article outlets have no YouTube channel page to scrape an avatar
 * from, so a channel with no `avatar` set and a non-YouTube `url` falls back
 * to that site's favicon (via Google's public s2 favicon service) instead of
 * shipping blank and relying on the Channels-tab monogram. YouTube channels
 * are left alone here — their avatar is populated once via
 * populateChannelAvatars, and a generic YouTube favicon would be a worse
 * fallback than the monogram.
 */
function handleGetChannels() {
  var sheet = getSheet('CHANNELS');
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { status: 'ok', channels: [] };

  var headers = data[0];
  var enabledCol = headers.indexOf('enabled');
  var channels = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var rawEnabled = enabledCol === -1 ? true : row[enabledCol];
    var enabled = rawEnabled === true || String(rawEnabled).toUpperCase() === 'TRUE';
    if (!enabled) continue;

    var channel = {};
    for (var j = 0; j < headers.length; j++) {
      channel[headers[j]] = row[j];
    }

    if (!channel.avatar && channel.url) {
      var domain = extractDomain(channel.url);
      if (domain && !/(^|\.)youtube\.com$/i.test(domain) && domain !== 'youtu.be') {
        channel.avatar = 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(domain) + '&sz=128';
      }
    }

    channels.push(channel);
  }

  return { status: 'ok', channels: channels };
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

  // Self-initialize the live/premiere columns (added after view tracking).
  // live_status: 'upcoming' | 'live' | 'none'; scheduled_start: ISO air time;
  // expires_at: ISO time after which a still-unaired/running entry is hidden.
  ['live_status', 'scheduled_start', 'expires_at'].forEach(function(col) {
    if (vHeaders.indexOf(col) === -1 && vHeaders.length > 0) {
      videosSheet.getRange(1, vHeaders.length + 1).setValue(col);
      vHeaders.push(col);
    }
  });
  var liveStatusCol = vHeaders.indexOf('live_status');
  var scheduledStartCol = vHeaders.indexOf('scheduled_start');
  var expiresAtCol = vHeaders.indexOf('expires_at');

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

      // Recover premiere/live state and a fresh view count (both unreliable in
      // RSS) from the Data API before persisting.
      enrichLiveMetadata(videos);

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
              else if (hName === 'live_status') newRow.push(video.live_status || 'none');
              else if (hName === 'scheduled_start') newRow.push(video.scheduled_start || '');
              else if (hName === 'expires_at') newRow.push(video.expires_at || '');
              else newRow.push('');
            }
          }

          videosSheet.appendRow(newRow);
          existingVideos[video.video_id] = true;
          newCount++;
        } else if (existingRowById[video.video_id]) {
          var existingRow = existingRowById[video.video_id];
          if (viewCountCol !== -1 && video.view_count) {
            // enrichLiveMetadata just refreshed this from the Data API. Only
            // videos still inside the channel's ~15-entry RSS window are fetched
            // and reach here, so a count stops updating once the video falls out
            // of the feed — older videos keep their last recorded count.
            videosSheet.getRange(existingRow, viewCountCol + 1).setValue(video.view_count);
          }
          // Re-enrich live state in place. A premiere/stream keeps its video id
          // when it becomes a VOD, so the SAME row transitions upcoming -> live
          // -> none: this clears expires_at once it airs, making the permanent
          // entry visible without ever creating a second row.
          if (liveStatusCol !== -1 && video.live_status !== undefined) {
            var ls = video.live_status;
            var ss = video.scheduled_start || '';
            var ex = video.expires_at || '';
            // The live-state trio is self-initialized as three adjacent columns
            // in exactly this order, so write it in one range call instead of
            // three round-trips. Fall back to per-cell writes on any legacy
            // sheet where the columns aren't contiguous.
            if (scheduledStartCol === liveStatusCol + 1 && expiresAtCol === liveStatusCol + 2) {
              videosSheet.getRange(existingRow, liveStatusCol + 1, 1, 3).setValues([[ls, ss, ex]]);
            } else {
              videosSheet.getRange(existingRow, liveStatusCol + 1).setValue(ls);
              if (scheduledStartCol !== -1) videosSheet.getRange(existingRow, scheduledStartCol + 1).setValue(ss);
              if (expiresAtCol !== -1) videosSheet.getRange(existingRow, expiresAtCol + 1).setValue(ex);
            }
          }
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

  // Archive videos past the retention window so the every-request scan in
  // readAllVideos stays bounded. Runs before the cache invalidations below so
  // the head/top-week caches repopulate against the pruned totals.
  var archived = pruneOldVideos();

  // The crawl appended rows and refreshed view counts / live state in place —
  // the cached head and the cached top-week window no longer reflect the sheet.
  invalidateFeedHead();
  invalidateTopWeek();

  log('INFO', 'fetchAllFeeds', 'Refresh complete. New: ' + newCount + ', Errors: ' + errorCount + ', Archived: ' + archived);
  return { new_videos: newCount, errors: errorCount, archived: archived };
}

/**
 * Moves videos older than PRUNE_AFTER_DAYS out of the live Videos sheet into an
 * "Archive" tab, keeping readAllVideos' every-request full scan bounded as the
 * catalog grows.
 *
 * Runs at the end of a crawl (crawlAllFeeds no longer holds the script lock by
 * then), and takes the script lock itself so it can't race a concurrent
 * vote/comment recount writing the same sheet — it reads AND rewrites the sheet
 * under one lock, so it never clobbers a count another writer just changed.
 *
 * A row is KEPT when its published_at is missing/unparseable, still within the
 * window, or it's a pending live/upcoming broadcast (or inside its expiry grace)
 * — those are inherently recent. Doomed rows are appended to the Archive tab
 * BEFORE removal, so a failure aborts without losing data; the archive is never
 * scanned by the feed.
 *
 * @returns {number} count of archived rows
 */
function pruneOldVideos() {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return 0; // busy — the next crawl reattempts
  }
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_IDS.VIDEOS);
    var sheet = ss.getSheets()[0];
    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) return 0;

    var headers = data[0];
    var pubCol = headers.indexOf('published_at');
    if (pubCol === -1) return 0; // can't age rows without a publish time
    var liveCol = headers.indexOf('live_status');
    var expCol = headers.indexOf('expires_at');

    var cutoff = Date.now() - PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000;
    var nowMs = Date.now();

    var keep = [];
    var archive = [];
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var t = new Date(row[pubCol]).getTime();

      var pendingLive = liveCol !== -1 &&
        (row[liveCol] === 'live' || row[liveCol] === 'upcoming');
      var expMs = expCol !== -1 && row[expCol] ? new Date(row[expCol]).getTime() : NaN;
      var unexpired = !isNaN(expMs) && expMs >= nowMs;

      if (isNaN(t) || t >= cutoff || pendingLive || unexpired) {
        keep.push(row);
      } else {
        archive.push(row);
      }
    }

    if (archive.length === 0) return 0;

    // Append doomed rows to the Archive tab first (created with the live
    // header on first use) so nothing is destroyed before it's copied.
    var archiveSheet = ss.getSheetByName(ARCHIVE_SHEET_NAME);
    if (!archiveSheet) {
      archiveSheet = ss.insertSheet(ARCHIVE_SHEET_NAME);
      archiveSheet.appendRow(headers);
    }
    archiveSheet
      .getRange(archiveSheet.getLastRow() + 1, 1, archive.length, headers.length)
      .setValues(archive);

    // Rewrite the live sheet as header + survivors: overwrite the top rows with
    // the kept data in one call, then physically remove the surplus trailing
    // rows the survivors no longer fill (so no emptied rows linger).
    var origDataRows = data.length - 1;
    if (keep.length > 0) {
      sheet.getRange(2, 1, keep.length, headers.length).setValues(keep);
    }
    var surplus = origDataRows - keep.length;
    if (surplus > 0) {
      sheet.deleteRows(keep.length + 2, surplus);
    }

    log('INFO', 'pruneOldVideos', 'Archived ' + archive.length + ' rows; ' + keep.length + ' remain');
    return archive.length;
  } catch (e) {
    log('ERROR', 'pruneOldVideos', e.message);
    return 0;
  } finally {
    lock.releaseLock();
  }
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

/**
 * Enriches parsed YouTube items in place with premiere/live broadcast state
 * and a fresh view count, from a single YouTube Data API videos.list call.
 *
 * A channel RSS entry for a premiere or scheduled live stream is byte-for-byte
 * indistinguishable from a normal upload — the feed carries no broadcast state
 * and no air time. The RSS feed likewise no longer carries a dependable view
 * count. We batch the 11-char video ids into the YouTube Data API videos.list
 * endpoint (part=snippet,liveStreamingDetails,statistics; up to 50 ids/call,
 * 1 quota unit per call regardless of parts) to recover, per item:
 *   - live_status:     snippet.liveBroadcastContent — 'upcoming' | 'live' | 'none'
 *   - scheduled_start: liveStreamingDetails.scheduledStartTime (upcoming/live)
 *   - expires_at:      when a still-unaired premiere or still-running stream
 *                      should stop being surfaced (scheduled start, or ingest
 *                      time if unknown, + LIVE_GRACE_MS). Left blank for 'none',
 *                      so a finished broadcast — which keeps the SAME video id
 *                      as it becomes a VOD — is permanent once it airs.
 *   - view_count:      statistics.viewCount — the live view count. Only videos
 *                      still inside the channel's ~15-entry RSS window reach
 *                      this call, so a video's count stops refreshing once it
 *                      falls out of the feed (it keeps its last recorded value).
 *
 * Requires a 'youtube_api_key' Meta value. Without a key, or on any API error,
 * this is a no-op and the crawl degrades to plain RSS behaviour (every item
 * treated as a normal, permanent upload; view counts left as first ingested).
 *
 * @param {Object[]} videos - Parsed item objects, mutated in place.
 */
function enrichLiveMetadata(videos) {
  var apiKey = getMeta('youtube_api_key');
  if (!apiKey) return;

  // Only genuine YouTube videos (exactly 11-char id) have broadcast state;
  // articles and hashed ids are skipped. Group so duplicate ids share a lookup.
  var ids = [];
  var byId = {};
  for (var i = 0; i < videos.length; i++) {
    var v = videos[i];
    if (v.media_type === 'video' && v.video_id && v.video_id.length === 11) {
      if (!byId[v.video_id]) { byId[v.video_id] = []; ids.push(v.video_id); }
      byId[v.video_id].push(v);
    }
  }
  if (ids.length === 0) return;

  var now = Date.now();

  for (var b = 0; b < ids.length; b += 50) {
    var batch = ids.slice(b, b + 50);
    var url = 'https://www.googleapis.com/youtube/v3/videos'
      + '?part=snippet,liveStreamingDetails,statistics'
      + '&fields=' + encodeURIComponent('items(id,snippet/liveBroadcastContent,liveStreamingDetails/scheduledStartTime,statistics/viewCount)')
      + '&id=' + batch.join(',')
      + '&key=' + encodeURIComponent(apiKey);

    try {
      var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (resp.getResponseCode() !== 200) {
        log('WARN', 'enrichLiveMetadata', 'videos.list HTTP ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 200));
        continue;
      }
      var items = (JSON.parse(resp.getContentText()).items) || [];
      for (var k = 0; k < items.length; k++) {
        var it = items[k];
        var status = (it.snippet && it.snippet.liveBroadcastContent) || 'none';
        var lsd = it.liveStreamingDetails || {};
        var scheduled = lsd.scheduledStartTime || '';
        var expires = '';

        if (status === 'upcoming' || status === 'live') {
          // Anchor expiry to the scheduled start when known, else to now.
          var base = scheduled ? new Date(scheduled).getTime() : now;
          if (isNaN(base)) base = now;
          expires = new Date(base + LIVE_GRACE_MS).toISOString();
        }

        // statistics.viewCount is a decimal string, and absent when a video
        // hides its stats. Only overwrite when the API returned an actual
        // number, so a hidden-stats item leaves the ingested count untouched.
        var views = (it.statistics && it.statistics.viewCount != null)
          ? parseInt(it.statistics.viewCount, 10) : NaN;

        var rows = byId[it.id] || [];
        for (var r = 0; r < rows.length; r++) {
          rows[r].live_status = status;
          rows[r].scheduled_start = scheduled;
          rows[r].expires_at = expires;
          if (!isNaN(views)) rows[r].view_count = views;
        }
      }
    } catch (e) {
      log('WARN', 'enrichLiveMetadata', 'videos.list failed: ' + e.message);
    }
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
  var nowMs = Date.now();

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var video = {};
    for (var j = 0; j < headers.length; j++) {
      video[headers[j]] = row[j];
    }

    // Drop provisional premiere/live entries whose expiry has passed. A
    // scheduled premiere or running stream is surfaced while fresh; when it
    // ends, the crawl re-enriches the SAME video id, clears expires_at, and the
    // row reappears as a permanent VOD. One that never airs simply expires out.
    if (video.expires_at) {
      var expMs = new Date(video.expires_at).getTime();
      if (!isNaN(expMs) && expMs < nowMs) continue;
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
  var start = (page - 1) * limit;

  // Fast path: serve early no-cursor pages from the cached feed head, skipping
  // the full sheet scan + sort. Cursor requests always take the live path —
  // resolving an arbitrary cursor position needs the whole sorted catalog.
  if (!cursor && start + limit <= FEED_HEAD_COUNT) {
    var head = readFeedHead();
    // The head can answer iff the window fits inside it — or it holds the
    // ENTIRE catalog, in which case a short/empty slice is the true answer.
    if (head && (start + limit <= head.videos.length || head.videos.length >= head.total)) {
      var fromHead = head.videos.slice(start, start + limit);
      return {
        status: 'ok',
        videos: fromHead,
        total: head.total,
        page: page,
        next_cursor: (fromHead.length > 0 && start + fromHead.length < head.total)
          ? cursorFor(fromHead[fromHead.length - 1])
          : '',
      };
    }
  }

  var videos = readAllVideos();

  if (videos.length === 0) {
    return { status: 'ok', videos: [], total: 0, page: page, next_cursor: '' };
  }

  // Sort by published_at descending (newest first), video_id tiebreak
  videos.sort(compareVideos);

  // Read-through populate: any full-path request refreshes the head for the
  // next caller. Best-effort — an oversized value or cache hiccup just means
  // the next request scans the sheet again.
  try {
    CacheService.getScriptCache().put(FEED_HEAD_CACHE_KEY, JSON.stringify({
      videos: videos.slice(0, FEED_HEAD_COUNT),
      total: videos.length,
    }), FEED_HEAD_CACHE_SECONDS);
  } catch (e) {
    /* cache write is optional */
  }

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
 * Reads the cached feed head, or null on any miss/problem. A head containing
 * a provisional premiere/live entry whose expiry has passed is treated as a
 * miss rather than re-filtered — dropping rows here would shift the slice
 * offsets and total; the live path re-derives everything consistently.
 */
function readFeedHead() {
  try {
    var raw = CacheService.getScriptCache().get(FEED_HEAD_CACHE_KEY);
    if (!raw) return null;
    var head = JSON.parse(raw);
    if (!head || !Array.isArray(head.videos) || typeof head.total !== 'number') return null;
    var nowMs = Date.now();
    for (var i = 0; i < head.videos.length; i++) {
      var exp = head.videos[i].expires_at;
      if (exp) {
        var expMs = new Date(exp).getTime();
        if (!isNaN(expMs) && expMs < nowMs) return null;
      }
    }
    return head;
  } catch (e) {
    return null;
  }
}

/**
 * Drops the cached feed head. Call from ANY writer that changes what the head
 * would contain — crawl completions (new rows, refreshed view counts / live
 * state) and vote/comment recounts (counts are baked into the cached rows).
 * Cheap enough to call unconditionally; the next feed request repopulates.
 */
function invalidateFeedHead() {
  try {
    CacheService.getScriptCache().remove(FEED_HEAD_CACHE_KEY);
  } catch (e) {
    /* best-effort */
  }
}

/**
 * Reads the cached Top-This-Week payload, or null on any miss/problem. Mirrors
 * readFeedHead: a cached entry holding a provisional premiere/live item whose
 * expiry has passed is treated as a miss rather than served — the live path
 * re-derives the ranked window cleanly from readAllVideos (which drops expired
 * rows), so dropping one here would just desync the count.
 */
function readTopWeek() {
  try {
    var raw = CacheService.getScriptCache().get(TOP_WEEK_CACHE_KEY);
    if (!raw) return null;
    var payload = JSON.parse(raw);
    if (!payload || !Array.isArray(payload.videos) || typeof payload.total !== 'number') return null;
    var nowMs = Date.now();
    for (var i = 0; i < payload.videos.length; i++) {
      var exp = payload.videos[i].expires_at;
      if (exp) {
        var expMs = new Date(exp).getTime();
        if (!isNaN(expMs) && expMs < nowMs) return null;
      }
    }
    return payload;
  } catch (e) {
    return null;
  }
}

/**
 * Drops the cached Top-This-Week payload. Called from the same writers that
 * invalidate the feed head: crawl completions add rows to the window, and
 * vote/comment recounts change counts baked into the cached rows (votes also
 * reorder the ranking). Cheap enough to call unconditionally.
 */
function invalidateTopWeek() {
  try {
    CacheService.getScriptCache().remove(TOP_WEEK_CACHE_KEY);
  } catch (e) {
    /* best-effort */
  }
}

/**
 * Total order for Top This Week: vote_count descending, then published_at
 * descending, then video_id descending as a deterministic tiebreak. The
 * tiebreak matters for cursor pagination — without it two items with equal
 * votes and equal timestamps could swap between requests, letting a cursor
 * skip or repeat them (the same reason compareVideos carries an id tiebreak).
 */
function compareTopWeek(a, b) {
  var av = Number(a.vote_count) || 0;
  var bv = Number(b.vote_count) || 0;
  if (bv !== av) return bv - av;
  var diff = pubTime(b) - pubTime(a);
  if (diff !== 0) return diff;
  var aId = String(a.video_id || '');
  var bId = String(b.video_id || '');
  return aId < bId ? 1 : (aId > bId ? -1 : 0);
}

/** Opaque cursor for the position AFTER this video in the top-week order. */
function topCursorFor(video) {
  return (Number(video.vote_count) || 0) + '|' +
    new Date(pubTime(video)).toISOString() + '|' + video.video_id;
}

/** Parses a top-week cursor "votes|iso|id" into its parts, or null if malformed. */
function parseTopCursor(cursor) {
  var i1 = cursor.indexOf('|');
  if (i1 === -1) return null;
  var i2 = cursor.indexOf('|', i1 + 1);
  if (i2 === -1) return null;
  var votes = Number(cursor.slice(0, i1));
  var time = new Date(cursor.slice(i1 + 1, i2)).getTime();
  if (isNaN(votes) || isNaN(time)) return null;
  // video_id is the remainder — it never itself contains '|' (YouTube ids and
  // web-safe base64 article ids are alphanumeric), so this slice is exact.
  return { votes: votes, time: time, id: String(cursor.slice(i2 + 1)) };
}

/** True if `video` sorts strictly AFTER cursor position `c` in top-week order. */
function topAfterCursor(video, c) {
  var vv = Number(video.vote_count) || 0;
  if (vv !== c.votes) return vv < c.votes;
  var vt = pubTime(video);
  if (vt !== c.time) return vt < c.time;
  return String(video.video_id || '') < c.id;
}

/**
 * Returns videos published in the last 7 days, ranked by upvotes (most-voted
 * first, newest then video_id as tiebreaks). When votes are sparse this
 * gracefully degrades to the week's videos in reverse-chron order, so the tab
 * is never empty.
 *
 * Cursor-paginated exactly like getVideos: early no-cursor pages are served
 * from the cached ranked head; deeper pages resume strictly after the
 * (vote_count, published_at, video_id) position the client last saw. So the
 * WHOLE week is reachable by scrolling even though the cache only holds the
 * head — with sparse votes the order is reverse-chron, so paging simply walks
 * back through the week instead of stopping at the newest cap.
 */
function handleTopWeek(params) {
  // Read-only by design. The Videos sheet is kept fresh by the feed request
  // (handleFeed refreshes when stale) and the scheduled trigger — so this
  // request just reads and ranks. Crawling RSS here (fetchAllFeeds, ~0.5s per
  // channel plus retry backoff) made the request slow enough to time out, and
  // unlike the feed the top-week tab has no cached fallback, so a slow crawl
  // surfaced to the user as an outright failure.
  var limit = parseInt(params.limit) || 50;
  var page = parseInt(params.page) || 1;
  var cursor = params.cursor || '';
  var start = (page - 1) * limit;

  // Fast path: serve early no-cursor pages from the cached ranked head, skipping
  // the full sheet scan + sort. Cursor requests always take the live path —
  // resolving an arbitrary cursor position needs the whole sorted window.
  if (!cursor && start + limit <= TOP_WEEK_CACHE_COUNT) {
    var cached = readTopWeek();
    // The head can answer iff the window fits inside it — or it already holds
    // the ENTIRE week (fewer rows than the cap), in which case a short/empty
    // slice is the true answer.
    if (cached && (start + limit <= cached.videos.length || cached.videos.length >= cached.total)) {
      var fromCache = cached.videos.slice(start, start + limit);
      return {
        status: 'ok',
        videos: fromCache,
        total: cached.total,
        page: page,
        next_cursor: (fromCache.length > 0 && start + fromCache.length < cached.total)
          ? topCursorFor(fromCache[fromCache.length - 1])
          : '',
      };
    }
  }

  var cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

  var recent = readAllVideos().filter(function(v) {
    var t = new Date(v.published_at).getTime();
    return !isNaN(t) && t >= cutoff;
  });

  recent.sort(compareTopWeek);

  // Read-through populate for the next caller. Best-effort — an oversized value
  // or cache hiccup just means the next request scans the sheet again.
  try {
    CacheService.getScriptCache().put(TOP_WEEK_CACHE_KEY, JSON.stringify({
      videos: recent.slice(0, TOP_WEEK_CACHE_COUNT),
      total: recent.length,
    }), TOP_WEEK_CACHE_SECONDS);
  } catch (e) {
    /* cache write is optional */
  }

  // Cursor pagination: resume strictly after the (vote_count, published_at,
  // video_id) position the client last saw. Unlike a page offset, a vote that
  // reorders the window mid-scroll can't make forward paging skip a whole page
  // — at worst it nudges one item across the boundary, which the client dedupes.
  if (cursor) {
    var c = parseTopCursor(cursor);
    if (c) {
      start = 0;
      while (start < recent.length && !topAfterCursor(recent[start], c)) start++;
    }
  }

  var paged = recent.slice(start, start + limit);

  return {
    status: 'ok',
    videos: paged,
    total: recent.length,
    page: page,
    next_cursor: (paged.length > 0 && start + paged.length < recent.length)
      ? topCursorFor(paged[paged.length - 1])
      : '',
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
  var user = authenticateUser(token);
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

  // comment_count is baked into both the cached feed head and the cached
  // top-week rows — drop them so the next request serves the new count.
  invalidateFeedHead();
  invalidateTopWeek();
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

  var user = authenticateUser(token);
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

  var user = authenticateUser(token);
  if (!user) {
    return { status: 'error', message: 'Invalid authentication token' };
  }

  return { status: 'ok', video_ids: readUserVoteIds(user.email) };
}

/** Video ids the given user has upvoted. Shared by myVotes and bootstrap. */
function readUserVoteIds(email) {
  var sheet = getVotesSheet();
  var rows = sheet.getDataRange().getValues();
  var headers = rows[0];
  var videoIdCol = headers.indexOf('video_id');
  var emailCol = headers.indexOf('user_email');

  var ids = [];
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][emailCol] === email) ids.push(rows[i][videoIdCol]);
  }
  return ids;
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

  // vote_count is baked into the cached feed head AND drives the top-week
  // ranking — drop both so the next request serves the new count and order.
  invalidateFeedHead();
  invalidateTopWeek();

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

  var user = authenticateUser(token);
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

  var user = authenticateUser(token);
  if (!user) {
    return { status: 'error', message: 'Invalid authentication token' };
  }

  return { status: 'ok', channels: readUserStarChannels(user.email) };
}

/** Channel names the given user has starred. Shared by myStars and bootstrap. */
function readUserStarChannels(email) {
  var sheet = getStarsSheet();
  var rows = sheet.getDataRange().getValues();
  var headers = rows[0];
  var channelCol = headers.indexOf('channel_name');
  var emailCol = headers.indexOf('user_email');

  var channels = [];
  for (var i = 1; i < rows.length; i++) {
    // Coerce to string so numeric/date-like channel names round-trip intact
    var ch = String(rows[i][channelCol]);
    if (rows[i][emailCol] === email && channels.indexOf(ch) === -1) {
      channels.push(ch);
    }
  }
  return channels;
}

/**
 * One round trip for everything the client needs about the signed-in user on
 * load: their upvoted video ids AND starred channels. Replaces the separate
 * myVotes + myStars POSTs fired back-to-back at sign-in — each re-verified the
 * ID token over the network and, because Apps Script serializes a user's
 * requests, queued nose-to-tail. Here the token is verified ONCE.
 */
function handleBootstrap(data) {
  var token = data.token;
  if (!token) {
    return { status: 'error', message: 'token is required' };
  }

  var user = authenticateUser(token);
  if (!user) {
    return { status: 'error', message: 'Invalid authentication token' };
  }

  return {
    status: 'ok',
    video_ids: readUserVoteIds(user.email),
    channels: readUserStarChannels(user.email),
  };
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
  // Fast path: a token verified moments ago is served from the script cache,
  // skipping the ~100-500ms tokeninfo round trip. Keyed by a hash of the token
  // (never the raw token). The cache is best-effort — any failure falls through
  // to a live verification.
  var cache = null;
  var cacheKey = null;
  try {
    cache = CacheService.getScriptCache();
    cacheKey = 'tok_' + tokenHash(idToken);
    var cached = cache.get(cacheKey);
    if (cached) {
      var claims = JSON.parse(cached);
      // Re-check expiry locally so a token can never be trusted past its own exp.
      if (claims.exp && parseInt(claims.exp, 10) * 1000 > Date.now()) {
        return { email: claims.email, name: claims.name, picture: claims.picture };
      }
    }
  } catch (e) {
    cache = null;
  }

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

    var user = {
      email: payload.email,
      name: payload.name || payload.email.split('@')[0],
      picture: payload.picture || '',
    };

    // Cache the verified identity so repeat calls in the same short window
    // (bootstrap, then rapid votes/stars) skip the tokeninfo fetch. Never cache
    // a failure, and never past the token's own expiry (TTL capped at 1h).
    if (cache && cacheKey) {
      try {
        var ttl = Math.min(parseInt(payload.exp, 10) - Math.floor(Date.now() / 1000), 3600);
        if (ttl > 0) {
          cache.put(cacheKey, JSON.stringify({
            email: user.email, name: user.name, picture: user.picture, exp: payload.exp,
          }), ttl);
        }
      } catch (e) {
        // best-effort — a cache write failure just means the next call re-verifies
      }
    }

    return user;
  } catch (error) {
    log('ERROR', 'verifyGoogleToken', error.message);
    return null;
  }
}

/** Short, stable cache key for an ID token. Hashes so the raw token is never stored. */
function tokenHash(idToken) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken);
  return Utilities.base64EncodeWebSafe(bytes);
}

// ============================================================
// SESSION TOKENS (app-issued, HMAC-signed)
// ============================================================

/**
 * Resolves a request to a user, accepting EITHER an app session token or a
 * Google ID token. Every POST handler calls this instead of verifyGoogleToken,
 * so a signed-in client authenticates with its long-lived session token and
 * never re-hits Google. Session verification is a local HMAC check — no
 * tokeninfo round trip — so it's also cheaper than a Google verify.
 *
 * @param {string} token - App session token (wds1.…) or Google ID token
 * @returns {{email:string,name:string,picture:string}|null}
 */
function authenticateUser(token) {
  if (!token) return null;
  if (token.indexOf(SESSION_TOKEN_PREFIX) === 0) {
    return verifySessionToken(token);
  }
  return verifyGoogleToken(token);
}

/**
 * The HMAC secret used to sign session tokens. Stored in Script Properties and
 * generated on first use, so there is no manual setup step. Cached per
 * execution. Clearing it invalidates every outstanding session — clients then
 * silently re-mint on their next authenticated call.
 */
function getSessionSecret() {
  if (_cachedSessionSecret) return _cachedSessionSecret;
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('SESSION_HMAC_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid(); // ~256 bits of entropy
    props.setProperty('SESSION_HMAC_SECRET', secret);
  }
  _cachedSessionSecret = secret;
  return secret;
}

/** base64url(HMAC-SHA256(body, secret)) — the signature over a token body. */
function sessionSignature(body) {
  var sig = Utilities.computeHmacSha256Signature(body, getSessionSecret());
  return Utilities.base64EncodeWebSafe(sig);
}

/**
 * Mints a session token for a verified user: `wds1.<body>.<sig>` where body is
 * base64url(JSON({e,n,p,iat,exp})) and sig is its HMAC. exp is SESSION_TTL_DAYS
 * out; the client slides it forward by re-minting before it lapses.
 *
 * @param {{email:string,name:string,picture:string}} user
 * @returns {string}
 */
function mintSessionToken(user) {
  var nowSec = Math.floor(Date.now() / 1000);
  var payload = {
    e: user.email,
    n: user.name || '',
    p: user.picture || '',
    iat: nowSec,
    exp: nowSec + SESSION_TTL_DAYS * 24 * 60 * 60,
  };
  var body = Utilities.base64EncodeWebSafe(JSON.stringify(payload));
  return SESSION_TOKEN_PREFIX + body + '.' + sessionSignature(body);
}

/**
 * Verifies an app session token and returns { email, name, picture } or null.
 * Recomputes the HMAC and compares it in constant time, then enforces expiry so
 * a token can never outlive its own exp even if the signature checks out.
 *
 * @param {string} token
 * @returns {{email:string,name:string,picture:string}|null}
 */
function verifySessionToken(token) {
  try {
    if (!token || token.indexOf(SESSION_TOKEN_PREFIX) !== 0) return null;
    var rest = token.substring(SESSION_TOKEN_PREFIX.length);
    var dot = rest.indexOf('.');
    if (dot === -1) return null;
    var body = rest.substring(0, dot);
    var sig = rest.substring(dot + 1);

    if (!constantTimeEquals(sig, sessionSignature(body))) return null;

    var json = Utilities.newBlob(Utilities.base64DecodeWebSafe(body)).getDataAsString();
    var payload = JSON.parse(json);
    if (!payload.exp || parseInt(payload.exp, 10) * 1000 <= Date.now()) return null;
    if (!payload.e) return null;

    return { email: payload.e, name: payload.n || '', picture: payload.p || '' };
  } catch (error) {
    log('ERROR', 'verifySessionToken', error.message);
    return null;
  }
}

/** Length-then-content comparison with no early-out on the content byte loop. */
function constantTimeEquals(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Mints (or renews) an app session token. Accepts a Google ID token — the
 * first exchange right after sign-in — OR an existing, still-valid session
 * token — the silent slide a returning visitor's page does on load. Either way
 * a fresh SESSION_TTL_DAYS token is issued, so an active user never re-hits
 * Google One Tap.
 *
 * @param {{token:string}} data
 * @returns {Object}
 */
function handleSession(data) {
  var token = data.token;
  if (!token) {
    return { status: 'error', message: 'token is required' };
  }

  var user = authenticateUser(token);
  if (!user) {
    return { status: 'error', message: 'Invalid authentication token' };
  }

  return {
    status: 'ok',
    sessionToken: mintSessionToken(user),
    email: user.email,
    name: user.name,
    picture: user.picture,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_DAYS * 24 * 60 * 60,
  };
}

/**
 * Editor-runnable sanity check for the session-token crypto. Logs PASS/FAIL for
 * the happy path, prefix routing, a tampered signature, a forged body, and an
 * expired token. Run from the Apps Script editor after any change to the
 * mint/verify functions.
 */
function runSessionSelfTest() {
  var results = [];
  var user = { email: 'test@example.com', name: 'Test User', picture: 'http://x/y.png' };
  var nowSec = Math.floor(Date.now() / 1000);

  // Happy path: mint → verify round-trips identity.
  var tok = mintSessionToken(user);
  var v = verifySessionToken(tok);
  results.push(['happy path round-trips identity',
    !!v && v.email === user.email && v.name === user.name && v.picture === user.picture]);

  // Prefix routing: authenticateUser resolves a session token without Google.
  var au = authenticateUser(tok);
  results.push(['authenticateUser routes session token', !!au && au.email === user.email]);

  // Tampered signature is rejected.
  var tampered = tok.slice(0, -1) + (tok.slice(-1) === 'A' ? 'B' : 'A');
  results.push(['tampered signature rejected', verifySessionToken(tampered) === null]);

  // Forged body (attacker payload) with a valid-looking sig from another token is rejected.
  var forgedBody = Utilities.base64EncodeWebSafe(JSON.stringify(
    { e: 'attacker@example.com', n: '', p: '', iat: nowSec, exp: nowSec + 3600 }));
  var origSig = tok.substring(tok.lastIndexOf('.') + 1);
  results.push(['forged body rejected',
    verifySessionToken(SESSION_TOKEN_PREFIX + forgedBody + '.' + origSig) === null]);

  // Expired token is rejected even though its signature is valid.
  var expiredBody = Utilities.base64EncodeWebSafe(JSON.stringify(
    { e: user.email, n: user.name, p: user.picture, iat: nowSec - 120, exp: nowSec - 60 }));
  var expiredTok = SESSION_TOKEN_PREFIX + expiredBody + '.' + sessionSignature(expiredBody);
  results.push(['expired token rejected', verifySessionToken(expiredTok) === null]);

  var allPass = true;
  for (var i = 0; i < results.length; i++) {
    if (!results[i][1]) allPass = false;
    Logger.log((results[i][1] ? 'PASS' : 'FAIL') + ' — ' + results[i][0]);
  }
  Logger.log(allPass ? 'ALL PASSED' : 'SOME FAILED');
  return allPass;
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
  // Auth is enforced by the router (isAdmin, constant-time) before we get here;
  // logs carry user emails, so this is only ever reached for a verified admin.
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
