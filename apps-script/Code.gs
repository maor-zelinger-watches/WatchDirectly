/**
 * WatchDirectly — Google Apps Script Backend (Code.gs)
 * 
 * Deploy as a web app from inside the Google Sheet:
 *   Deploy → New Deployment → Web App
 *   Execute as: Me | Who has access: Anyone
 * 
 * Sheets expected:
 *   1. Channels  — creator list with channel_id and feed_url
 *   2. Videos    — aggregated video entries
 *   3. Comments  — threaded comments
 *   4. Meta      — config key-value pairs
 *   5. BlockedUsers — blocked email addresses
 *   6. Logs      — structured debug logs
 */

// ============================================================
// CONFIGURATION
// ============================================================

const SHEET_CHANNELS = 'Channels';
const SHEET_VIDEOS = 'Videos';
const SHEET_COMMENTS = 'Comments';
const SHEET_META = 'Meta';
const SHEET_BLOCKED = 'BlockedUsers';
const SHEET_LOGS = 'Logs';

const DEFAULT_REFRESH_HOURS = 4;
const DEFAULT_PAGE_LIMIT = 20;

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

// Cache the log level per execution to avoid repeated sheet reads
let _cachedLogLevel = null;

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
    const data = JSON.parse(e.postData.contents);
    const action = data.action || '';

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
// FEED HANDLER
// ============================================================

function handleFeed(params) {
  // Check if refresh needed
  const lastFetch = getMeta('last_fetch');
  const refreshHours = parseInt(getMeta('refresh_interval_hours')) || DEFAULT_REFRESH_HOURS;
  const staleThreshold = refreshHours * 60 * 60 * 1000;

  if (!lastFetch || (Date.now() - new Date(lastFetch).getTime()) > staleThreshold) {
    log('INFO', 'handleFeed', 'Feed is stale, triggering refresh');
    fetchAllFeeds();
  }

  const page = parseInt(params.page) || 1;
  const limit = parseInt(params.limit) || DEFAULT_PAGE_LIMIT;

  return getVideos(page, limit);
}

function handleRefresh() {
  log('INFO', 'handleRefresh', 'Manual refresh triggered');
  const stats = fetchAllFeeds();
  return { status: 'ok', ...stats };
}

// ============================================================
// RSS FEED FETCHING
// ============================================================

function fetchAllFeeds() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const channelsSheet = ss.getSheetByName(SHEET_CHANNELS);
  const videosSheet = ss.getSheetByName(SHEET_VIDEOS);

  const channelData = channelsSheet.getDataRange().getValues();
  const headers = channelData[0];
  const feedUrlCol = headers.indexOf('feed_url');
  const channelNameCol = headers.indexOf('channel_name');
  const tierCol = headers.indexOf('tier');
  const categoryCol = headers.indexOf('category');
  const enabledCol = headers.indexOf('enabled');

  // Get existing video IDs for deduplication
  const existingVideos = new Set();
  const videoData = videosSheet.getDataRange().getValues();
  if (videoData.length > 1) {
    const videoIdCol = videoData[0].indexOf('video_id');
    for (let i = 1; i < videoData.length; i++) {
      existingVideos.add(videoData[i][videoIdCol]);
    }
  }

  let newCount = 0;
  let errorCount = 0;

  for (let i = 1; i < channelData.length; i++) {
    const row = channelData[i];
    const enabled = enabledCol === -1 || row[enabledCol] === true || row[enabledCol] === 'TRUE';
    if (!enabled) continue;

    const feedUrl = row[feedUrlCol];
    const channelName = row[channelNameCol];
    const tier = row[tierCol];
    const category = row[categoryCol];

    if (!feedUrl) {
      log('WARN', 'fetchAllFeeds', 'No feed_url for channel: ' + channelName);
      continue;
    }

    try {
      const videos = fetchAndParseFeed(feedUrl, channelName, tier, category);

      for (const video of videos) {
        if (!existingVideos.has(video.video_id)) {
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
          existingVideos.add(video.video_id);
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
  const response = UrlFetchApp.fetch(feedUrl, { muteHttpExceptions: true });

  if (response.getResponseCode() !== 200) {
    throw new Error('HTTP ' + response.getResponseCode());
  }

  const xml = response.getContentText();
  return parseRssFeed(xml, channelName, tier, category);
}

function parseRssFeed(xml, channelName, tier, category) {
  const doc = XmlService.parse(xml);
  const root = doc.getRootElement();
  const ns = XmlService.getNamespace('http://www.w3.org/2005/Atom');
  const ytNs = XmlService.getNamespace('yt', 'http://www.youtube.com/xml/schemas/2015');

  const entries = root.getChildren('entry', ns);
  const videos = [];

  for (const entry of entries) {
    const videoIdEl = entry.getChild('videoId', ytNs);
    const titleEl = entry.getChild('title', ns);
    const publishedEl = entry.getChild('published', ns);
    const linkEl = entry.getChild('link', ns);

    if (!videoIdEl || !titleEl) continue;

    const videoId = videoIdEl.getText();
    const title = titleEl.getText();
    const published = publishedEl ? publishedEl.getText() : new Date().toISOString();
    const url = linkEl ? linkEl.getAttribute('href').getValue() : 'https://www.youtube.com/watch?v=' + videoId;

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
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_VIDEOS);
  const data = sheet.getDataRange().getValues();

  if (data.length <= 1) {
    return { status: 'ok', videos: [], total: 0, page: page };
  }

  const headers = data[0];
  const videos = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const video = {};
    for (let j = 0; j < headers.length; j++) {
      video[headers[j]] = row[j];
    }
    videos.push(video);
  }

  // Sort by published_at descending (newest first)
  videos.sort(function(a, b) {
    return new Date(b.published_at) - new Date(a.published_at);
  });

  // Paginate
  const start = (page - 1) * limit;
  const paged = videos.slice(start, start + limit);

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
  const videoId = params.videoId;
  if (!videoId) {
    return { status: 'error', message: 'videoId is required' };
  }
  return getComments(videoId);
}

function getComments(videoId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_COMMENTS);
  const data = sheet.getDataRange().getValues();

  if (data.length <= 1) {
    return { status: 'ok', comments: [] };
  }

  const headers = data[0];
  const videoIdCol = headers.indexOf('video_id');
  const comments = [];

  for (let i = 1; i < data.length; i++) {
    if (data[i][videoIdCol] !== videoId) continue;

    const comment = {};
    for (let j = 0; j < headers.length; j++) {
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
  const { videoId, parentId, body, token } = data;

  // Validate required fields
  if (!videoId || !body || !token) {
    return { status: 'error', message: 'videoId, body, and token are required' };
  }

  // Verify Google token and get user info
  const user = verifyGoogleToken(token);
  if (!user) {
    log('ERROR', 'addComment', 'Invalid Google token');
    return { status: 'error', message: 'Invalid authentication token' };
  }

  // Check if user is blocked
  if (isUserBlocked(user.email)) {
    log('ERROR', 'addComment', 'Blocked user attempted comment: ' + user.email);
    return { status: 'error', message: 'User is blocked' };
  }

  // Determine depth
  var depth = 0;
  if (parentId) {
    depth = 1; // Reply to a comment
    // Validate parent exists and is depth 0
    // (we only allow 2 levels: 0 and 1)
  }

  // Generate comment ID
  var commentId = 'c_' + Utilities.getUuid().replace(/-/g, '').substring(0, 12);

  // Append to Comments sheet
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_COMMENTS);
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

  // Update comment count on the video
  updateCommentCount(videoId);

  log('INFO', 'addComment', 'Comment added by ' + user.email + ' on video ' + videoId);

  return { status: 'ok', comment_id: commentId };
}

function updateCommentCount(videoId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Count comments for this video
  var commentsSheet = ss.getSheetByName(SHEET_COMMENTS);
  var commentsData = commentsSheet.getDataRange().getValues();
  var headers = commentsData[0];
  var videoIdCol = headers.indexOf('video_id');
  var count = 0;

  for (var i = 1; i < commentsData.length; i++) {
    if (commentsData[i][videoIdCol] === videoId) count++;
  }

  // Update the video row
  var videosSheet = ss.getSheetByName(SHEET_VIDEOS);
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
    // Use Google's tokeninfo endpoint to verify the ID token
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
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_BLOCKED);

  if (!sheet) return false;

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
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_META);
  var data = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) return data[i][1];
  }

  return null;
}

function setMeta(key, value) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_META);
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

  // Only log if the message level is >= configured level
  if (levelValue < configValue) return;

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_LOGS);

    if (!sheet) return;

    sheet.appendRow([
      new Date().toISOString(),
      level,
      source,
      message,
    ]);
  } catch (e) {
    // If logging itself fails, we can't do much
    Logger.log('Log write failed: ' + e.message);
  }
}

function handleLogs(params) {
  var count = parseInt(params.count) || 50;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_LOGS);

  if (!sheet) return { status: 'ok', logs: [] };

  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var logs = [];

  // Get last N rows (most recent)
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
