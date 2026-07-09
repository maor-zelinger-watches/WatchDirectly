/**
 * Test_Code.gs — editor-runnable diagnostics for the feed-fetch path.
 *
 * These are NOT part of the crawl and are never called by doGet/doPost or any
 * trigger. Run them by hand from the Apps Script editor: pick a `test_…`
 * function in the toolbar dropdown, click Run, and read the output under
 * Executions (or View → Logs). They share global scope with Code.gs, so they
 * call its functions (getMeta, getSheet, extractFeedChannelId, fetchYouTubeUploads,
 * fetchAndParseFeed, …) directly.
 *
 * Background: YouTube serves 404/500 to youtube.com/feeds/videos.xml requests
 * from Apps Script's datacenter IPs, so the RSS crawl fails wholesale.
 * fetchAndParseFeed now tries RSS first and falls back to the YouTube Data API
 * (playlistItems.list on the channel's uploads playlist) when RSS fails or
 * returns nothing. These tests let you confirm that live.
 *
 * Start with test_help().
 */

/** Lists the available diagnostics and what each one does. */
function test_help() {
  Logger.log([
    'Feed-fetch diagnostics — run any of these from the editor:',
    '',
    '  test_extractAndDerive()          Pure logic, no network. Checks channel-id',
    '                                   extraction + the UC→UU uploads-playlist trick.',
    '  test_parseYouTubeUploads()       Pure logic, no network. Checks the API-JSON',
    '                                   → item mapping (thumbnails, dates, skips).',
    '  test_youtubeApiKey()             Confirms youtube_api_key is set and that ONE',
    '                                   live playlistItems.list call succeeds.',
    '  test_rssVsApiAllChannels()       For every enabled channel: raw RSS code+count',
    '                                   vs raw Data-API code+count, side by side.',
    '                                   This is the direct proof of the IP block.',
    '  test_fetchAndParseFeed_firstChannel()',
    '                                   Runs the REAL routing (RSS→API fallback) on the',
    '                                   first enabled channel and prints what it ingests.',
    '  test_probeTeddy()                Same, hard-wired to Teddy Baldassarre’s feed.',
  ].join('\n'));
}

// ── Pure-logic checks (safe to run anywhere, no network) ────────────────────

/** Verifies extractFeedChannelId and the UC→UU derivation. Logs PASS/FAIL. */
function test_extractAndDerive() {
  var cases = [
    ['https://www.youtube.com/feeds/videos.xml?channel_id=UCXPXfAAo-yV6Y-0PZecwBLw', 'UCXPXfAAo-yV6Y-0PZecwBLw'],
    ['https://www.youtube.com/feeds/videos.xml?foo=1&channel_id=UC0ulDfOIUVoZAhHPuCTiawg', 'UC0ulDfOIUVoZAhHPuCTiawg'],
    ['https://www.hodinkee.com/rss', ''],
    ['', ''],
  ];
  var pass = 0;
  for (var i = 0; i < cases.length; i++) {
    var got = extractFeedChannelId(cases[i][0]);
    var okc = got === cases[i][1];
    if (okc) pass++;
    Logger.log((okc ? 'PASS' : 'FAIL') + ' extractFeedChannelId("' + cases[i][0] + '") = "' + got + '"' +
      (okc ? '' : ' (expected "' + cases[i][1] + '")'));
  }
  var cid = 'UCXPXfAAo-yV6Y-0PZecwBLw';
  Logger.log('UC→UU derivation: ' + cid + ' → UU' + cid.slice(2));
  Logger.log(pass + '/' + cases.length + ' passed');
}

/** Verifies parseYouTubeUploads maps a playlistItems.list payload correctly. */
function test_parseYouTubeUploads() {
  var payload = JSON.stringify({
    items: [
      {
        snippet: {
          title: 'Rolex &amp; Tudor',
          publishedAt: '2026-07-01T10:00:00Z',
          thumbnails: { high: { url: 'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg' } },
        },
        contentDetails: { videoId: 'aaaaaaaaaaa', videoPublishedAt: '2026-07-01T09:30:00Z' },
      },
      { snippet: { title: 'Private video', thumbnails: {} }, contentDetails: { videoId: 'bbbbbbbbbbb' } },
      { snippet: { title: 'Orphan', thumbnails: {} }, contentDetails: {} },
    ],
  });
  var out = parseYouTubeUploads(payload, 'Test Channel', 2, 'Reviews');
  var checks = [
    ['dropped private + orphan (1 item left)', out.length === 1],
    ['video_id mapped', out[0] && out[0].video_id === 'aaaaaaaaaaa'],
    ['&amp; decoded in title', out[0] && out[0].title === 'Rolex & Tudor'],
    ['watch url built', out[0] && out[0].url === 'https://www.youtube.com/watch?v=aaaaaaaaaaa'],
    ['videoPublishedAt preferred', out[0] && out[0].published_at === '2026-07-01T09:30:00.000Z'],
    ['channel/tier/category carried', out[0] && out[0].channel_name === 'Test Channel' && out[0].tier === 2],
  ];
  var pass = 0;
  for (var i = 0; i < checks.length; i++) {
    if (checks[i][1]) pass++;
    Logger.log((checks[i][1] ? 'PASS' : 'FAIL') + ' ' + checks[i][0]);
  }
  Logger.log(pass + '/' + checks.length + ' passed');
}

// ── Live checks (hit the network) ───────────────────────────────────────────

/** Confirms the Data API key is set and that one live call works. */
function test_youtubeApiKey() {
  var apiKey = getMeta('youtube_api_key');
  if (!apiKey) {
    Logger.log('FAIL: youtube_api_key is not set in the META sheet.');
    return;
  }
  Logger.log('youtube_api_key present: ' + apiKey.slice(0, 6) + '… (' + apiKey.length + ' chars)');

  var channelId = 'UCLGp7H4XuzA9TLJ0L4PUx8w'; // Teddy Baldassarre
  var r = _t_probeApi_(channelId, apiKey);
  Logger.log('playlistItems.list (Teddy Baldassarre) → HTTP ' + r.code + ', items: ' + r.count);
  if (r.code === 403) {
    Logger.log('403 → the key is blocked. Check: YouTube Data API v3 is enabled for the key’s project,');
    Logger.log('and the key has no API/method restriction excluding playlistItems.list, and quota is left.');
  }
}

/**
 * The money diagnostic: for every enabled channel, logs the raw RSS response
 * (code + item count) next to the raw Data-API response. Expect RSS 404/500 and
 * API 200 while the IP block is in effect.
 */
function test_rssVsApiAllChannels() {
  var apiKey = getMeta('youtube_api_key');
  Logger.log('youtube_api_key: ' + (apiKey ? 'present' : 'MISSING'));

  var data = getSheet('CHANNELS').getDataRange().getValues();
  var h = data[0];
  var nameCol = h.indexOf('channel_name');
  var feedCol = h.indexOf('feed_url');
  var enabledCol = h.indexOf('enabled');

  var rssOk = 0, apiOk = 0, total = 0;
  for (var i = 1; i < data.length; i++) {
    var enabled = enabledCol === -1 ? true :
      (data[i][enabledCol] === true || String(data[i][enabledCol]).toUpperCase() === 'TRUE');
    if (!enabled) continue;
    total++;

    var name = String(data[i][nameCol] || '');
    var feedUrl = data[i][feedCol];
    var channelId = extractFeedChannelId(feedUrl);

    var rss = _t_probeRss_(feedUrl);
    if (rss.code === 200) rssOk++;

    var api = (channelId && apiKey) ? _t_probeApi_(channelId, apiKey) : { code: 'n/a', count: '-' };
    if (api.code === 200) apiOk++;

    Logger.log(_t_pad_(name, 34) + ' RSS ' + _t_pad_(rss.code + '/' + rss.count, 12) +
      ' API ' + api.code + '/' + api.count);
    Utilities.sleep(150); // be polite; also keeps us under per-second limits
  }
  Logger.log('──── ' + total + ' enabled | RSS 200: ' + rssOk + ' | API 200: ' + apiOk + ' ────');
}

/** Runs the real RSS→API routing on the first enabled channel. */
function test_fetchAndParseFeed_firstChannel() {
  var data = getSheet('CHANNELS').getDataRange().getValues();
  var h = data[0];
  var nameCol = h.indexOf('channel_name'), feedCol = h.indexOf('feed_url');
  var tierCol = h.indexOf('tier'), catCol = h.indexOf('category'), enabledCol = h.indexOf('enabled');

  for (var i = 1; i < data.length; i++) {
    var enabled = enabledCol === -1 ? true :
      (data[i][enabledCol] === true || String(data[i][enabledCol]).toUpperCase() === 'TRUE');
    if (!enabled) continue;
    _t_runFeed_(String(data[i][nameCol] || ''), data[i][feedCol], data[i][tierCol], data[i][catCol]);
    return;
  }
  Logger.log('No enabled channels found in the CHANNELS sheet.');
}

/** Runs the real routing hard-wired to Teddy Baldassarre. */
function test_probeTeddy() {
  _t_runFeed_(
    'Teddy Baldassarre',
    'https://www.youtube.com/feeds/videos.xml?channel_id=UCLGp7H4XuzA9TLJ0L4PUx8w',
    1, 'The Heavyweights & Entertainment'
  );
}

// ── Internal helpers (prefixed _t_ to avoid clashing with Code.gs) ───────────

function _t_runFeed_(name, feedUrl, tier, category) {
  try {
    var videos = fetchAndParseFeed(feedUrl, name, tier, category);
    Logger.log('fetchAndParseFeed("' + name + '") → ' + videos.length + ' items');
    for (var k = 0; k < Math.min(3, videos.length); k++) {
      Logger.log('  • ' + videos[k].published_at + '  ' + videos[k].video_id + '  ' + videos[k].title);
    }
  } catch (e) {
    Logger.log('fetchAndParseFeed("' + name + '") FAILED: ' + e.message);
  }
}

function _t_probeRss_(feedUrl) {
  try {
    var r = UrlFetchApp.fetch(feedUrl, { muteHttpExceptions: true });
    var code = r.getResponseCode();
    return { code: code, count: code === 200 ? _t_countFeedItems_(r.getContentText()) : '-' };
  } catch (e) {
    return { code: 'ERR', count: e.message };
  }
}

function _t_probeApi_(channelId, apiKey) {
  var url = 'https://www.googleapis.com/youtube/v3/playlistItems' +
    '?part=contentDetails&maxResults=15' +
    '&playlistId=UU' + channelId.slice(2) +
    '&key=' + encodeURIComponent(apiKey);
  try {
    var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var code = r.getResponseCode();
    return { code: code, count: code === 200 ? (((JSON.parse(r.getContentText()).items) || []).length) : '-' };
  } catch (e) {
    return { code: 'ERR', count: e.message };
  }
}

/** Rough item count from raw feed XML (Atom <entry> or RSS <item>). */
function _t_countFeedItems_(xml) {
  return (xml.match(/<entry[\s>]/g) || []).length + (xml.match(/<item[\s>]/g) || []).length;
}

function _t_pad_(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}
