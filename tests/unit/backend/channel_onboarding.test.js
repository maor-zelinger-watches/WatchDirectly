/**
 * Unit tests for the "add a channel from just a URL" feature (enrichChannels).
 *
 * Exercises the SHIPPED Code.gs the same way the other backend tests do: load
 * the source, patch the spreadsheet ids to in-memory sentinels, and mock the
 * Apps Script globals. A mocked UrlFetchApp serves realistic channel/site HTML
 * (the exact meta tags a real YouTube channel page and a WordPress/Hodinkee-style
 * site return) so the scraper's regexes are tested against representative input.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');

/** A stateful, mutable in-memory sheet backed by a 2-D array. */
function makeSheet(rows) {
  const grid = rows.map((r) => r.slice());
  return {
    _grid: grid,
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getRange: (row, col, numRows, numCols) => ({
      // Faithful block read (real Sheets implements this): the batched crawl
      // flush reads a column/trio block via getRange(...).getValues().
      getValues() {
        const nr = numRows || 1;
        const nc = numCols || 1;
        const out = [];
        for (let i = 0; i < nr; i++) {
          const r = grid[row - 1 + i] || [];
          const outRow = [];
          for (let j = 0; j < nc; j++) outRow.push(r[col - 1 + j] !== undefined ? r[col - 1 + j] : '');
          out.push(outRow);
        }
        return out;
      },
      setValue(v) {
        while (grid.length < row) grid.push([]);
        const r = grid[row - 1];
        while (r.length < col) r.push('');
        r[col - 1] = v;
      },
      setValues(values) {
        for (let i = 0; i < values.length; i++) {
          while (grid.length < row + i) grid.push([]);
          const r = grid[row - 1 + i];
          for (let j = 0; j < values[i].length; j++) {
            while (r.length < col + j) r.push('');
            r[col - 1 + j] = values[i][j];
          }
        }
      },
      setNumberFormat() {},
    }),
    appendRow: (r) => { grid.push(r.slice()); },
    getLastRow: () => grid.length,
  };
}

const CHANNEL_HEADERS = ['channel_name', 'host', 'tier', 'category', 'description', 'url', 'channel_id', 'feed_url', 'enabled', 'avatar'];

// Full Videos schema incl. the live trio, so the inline crawl never has to
// self-add columns.
const VIDEO_HEADERS = ['video_id', 'channel_name', 'title', 'url', 'published_at', 'fetched_at', 'tier', 'category', 'comment_count', 'vote_count', 'media_type', 'preview_image', 'view_count', 'live_status', 'scheduled_start', 'expires_at'];

// UC id is exactly 22 chars after the UC prefix.
const YT_CHANNEL_ID = 'UCabcdefghijklmnopqrstuv';

const YT_HTML = `<!doctype html><html><head>
  <link rel="canonical" href="https://www.youtube.com/channel/${YT_CHANNEL_ID}">
  <meta property="og:title" content="Watch Guy - YouTube">
  <meta property="og:image" content="https://yt3.googleusercontent.com/abc=s900-c-k-c0x00ffffff-no-rj">
  <script>{"channelId":"UCsomethingElse00000000"}</script>
</head><body></body></html>`;

const NEWS_HTML = `<!doctype html><html><head>
  <meta property="og:site_name" content="News &amp; Co">
  <link rel="alternate" type="application/rss+xml" title="RSS" href="/rss.xml">
</head><body></body></html>`;

// What news.example's declared feed actually serves — two items, so the
// add-channel path's inline crawl has real content to ingest.
const NEWS_FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>News &amp; Co</title>
  <item><title>First story</title><link>https://news.example/first</link>
    <pubDate>Mon, 21 Sep 2026 10:00:00 GMT</pubDate></item>
  <item><title>Second story</title><link>https://news.example/second</link>
    <pubDate>Mon, 21 Sep 2026 11:00:00 GMT</pubDate></item>
</channel></rss>`;

const BLOG_HTML = `<!doctype html><html><head><title>My Blog</title></head><body></body></html>`;

const RSS_BODY = `<?xml version="1.0"?><rss version="2.0"><channel><title>My Blog</title></channel></rss>`;

// A site with apple-touch-icons (two sizes, relative hrefs) and a declared feed.
const PAPER_HTML = `<!doctype html><html><head>
  <meta property="og:site_name" content="Paper Mag">
  <link rel="apple-touch-icon" sizes="120x120" href="/icons/touch-120.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/icons/touch-180.png?v=2&amp;x=1">
  <link rel="alternate" type="application/rss+xml" title="RSS" href="/rss.xml">
</head><body></body></html>`;

// Its feed carries a channel-level <link> (the site) and <image> — plus an item
// whose own <link>/media must NOT be mistaken for either.
const PAPER_FEED = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>Paper Mag</title>
  <link>https://paper.example</link>
  <image><url>https://paper.example/feed-logo.png</url><title>Paper Mag</title><link>https://paper.example</link></image>
  <item><title>A story</title><link>https://paper.example/a-story</link></item>
</channel></rss>`;

// A site with NO touch icon whose feed declares an (http://) image.
const MAG_HTML = `<!doctype html><html><head><title>Mag</title>
  <link rel="alternate" type="application/rss+xml" href="https://mag.example/feed.xml">
</head><body></body></html>`;
const MAG_FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Mag</title>
  <image><url>http://mag.example/feed-logo.png</url></image>
</channel></rss>`;

function ok200(text) {
  return { getResponseCode: () => 200, getContentText: () => text, getAllHeaders: () => ({}) };
}

function load(channelRows, opts = {}) {
  const metaRows = (opts.metaRows || [['key', 'value'], ['log_level', 'ERROR']]).map((r) => r.slice());
  if (opts.adminToken) metaRows.push(['admin_token', opts.adminToken]);
  const sheets = {
    CHANNELS_ID: opts.channelsSheet || makeSheet([CHANNEL_HEADERS, ...channelRows]),
    META_ID: makeSheet(metaRows),
    // handleAddChannel crawls the feed it just added, so the add path now
    // touches Videos and Logs too.
    VIDEOS_ID: opts.videosSheet || makeSheet([VIDEO_HEADERS]),
    LOGS_ID: makeSheet([['ts', 'level', 'source', 'message']]),
  };
  const calls = [];
  const fetch = (u) => {
    calls.push(u);
    if (u === 'https://www.youtube.com/@WatchGuy') return ok200(YT_HTML);
    if (u === 'https://news.example') return ok200(NEWS_HTML);
    if (u === 'https://news.example/rss.xml') return ok200(NEWS_FEED);
    if (u === 'https://blog.example') return ok200(BLOG_HTML);
    if (u === 'https://blog.example/feed/') return ok200(RSS_BODY);
    if (u === 'https://paper.example') return ok200(PAPER_HTML);
    if (u === 'https://paper.example/rss.xml') return ok200(PAPER_FEED);
    if (u === 'https://mag.example') return ok200(MAG_HTML);
    if (u === 'https://mag.example/feed.xml') return ok200(MAG_FEED);
    return { getResponseCode: () => 404, getContentText: () => '', getAllHeaders: () => ({}) };
  };

  // jsonResponse serializes through ContentService; capture each payload so
  // doPost's replies can be asserted on.
  const responses = [];
  // Stateful, so firstInWindow_'s once-per-window suppression is really
  // exercised rather than mocked away.
  const cacheStore = new Map();
  const globals = {
    UrlFetchApp: { fetch },
    SpreadsheetApp: {
      openById: (id) => ({ getSheets: () => [sheets[id]] }),
      flush() {},
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      sleep() {},
      getUuid: () => '0',
      DigestAlgorithm: { MD5: 'MD5' },
      // Input-dependent on purpose: the crawl hashes each item's guid/link into
      // its id, so a constant digest would collapse every item of a feed under
      // one id and the id dedup would drop all but the first.
      computeDigest: (_algo, text) => Array.from(String(text)).map((c) => c.charCodeAt(0)),
      base64EncodeWebSafe: (bytes) => 'ID' + bytes.reduce((a, b) => (a * 31 + b) % 1e12, 7).toString(36),
    },
    Logger: { log() {} },
    ContentService: {
      createTextOutput: (text) => { responses.push(JSON.parse(text)); return { setMimeType: () => ({}) }; },
      MimeType: { JSON: 'json' },
    },
    ScriptApp: opts.scriptApp || {},
    XmlService: undefined,
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cacheStore.has(k) ? cacheStore.get(k) : null),
        put: (k, v) => cacheStore.set(k, v),
        remove: (k) => cacheStore.delete(k),
      }),
    },
  };
  const patched = SRC
    .replace(/CHANNELS:\s*'[^']+'/, "CHANNELS: 'CHANNELS_ID'")
    .replace(/META:\s*'[^']+'/, "META: 'META_ID'")
    .replace(/VIDEOS:\s*'[^']+'/, "VIDEOS: 'VIDEOS_ID'")
    .replace(/LOGS:\s*'[^']+'/, "LOGS: 'LOGS_ID'");

  const names = ['enrichChannels', 'resolveChannelFromUrl', 'scheduledFetchAllFeeds', 'runScheduledEnrichment', 'handleAddChannel', 'scheduleRefresh', 'doPost'];
  const factory = new Function(...Object.keys(globals), `${patched}\nreturn { ${names.join(', ')} };`);
  return { ...factory(...Object.values(globals)), sheets, calls, responses };
}

/** Builds the doPost event Apps Script hands the web app for a JSON body. */
function postEvent(body) {
  return { postData: { contents: JSON.stringify(body) } };
}

/** Column lookup against the header row. */
function cell(grid, rowIdx, name) {
  return grid[rowIdx][CHANNEL_HEADERS.indexOf(name)];
}

describe('enrichChannels — fills missing channel metadata from a URL', () => {
  it('resolves a YouTube handle URL into id, feed, name, avatar, and enables it', () => {
    const be = load([
      ['', '', '', '', '', 'https://www.youtube.com/@WatchGuy', '', '', '', ''],
    ]);
    const summary = be.enrichChannels();

    expect(summary.processed).toBe(1);
    const grid = be.sheets.CHANNELS_ID._grid;
    expect(cell(grid, 1, 'channel_id')).toBe(YT_CHANNEL_ID);
    expect(cell(grid, 1, 'feed_url')).toBe('https://www.youtube.com/feeds/videos.xml?channel_id=' + YT_CHANNEL_ID);
    expect(cell(grid, 1, 'channel_name')).toBe('Watch Guy'); // " - YouTube" stripped
    expect(cell(grid, 1, 'avatar')).toBe('https://yt3.googleusercontent.com/abc=s900-c-k-c0x00ffffff-no-rj');
    expect(cell(grid, 1, 'enabled')).toBe(true);
  });

  it('discovers a declared RSS <link> (relative href) on a news site', () => {
    const be = load([
      ['', '', '', '', '', 'https://news.example', '', '', '', ''],
    ]);
    be.enrichChannels();
    const grid = be.sheets.CHANNELS_ID._grid;
    expect(cell(grid, 1, 'feed_url')).toBe('https://news.example/rss.xml'); // resolved absolute
    expect(cell(grid, 1, 'channel_name')).toBe('News & Co'); // entity-decoded
    expect(cell(grid, 1, 'enabled')).toBe(true);
    expect(cell(grid, 1, 'avatar')).toBe(''); // left blank — favicon fallback at read time
    expect(cell(grid, 1, 'channel_id')).toBe(''); // no channel id for a site
  });

  it('probes a common feed path when no <link> is declared', () => {
    const be = load([
      ['', '', '', '', '', 'https://blog.example', '', '', '', ''],
    ]);
    be.enrichChannels();
    const grid = be.sheets.CHANNELS_ID._grid;
    expect(cell(grid, 1, 'feed_url')).toBe('https://blog.example/feed/');
    expect(cell(grid, 1, 'channel_name')).toBe('My Blog');
    expect(cell(grid, 1, 'enabled')).toBe(true);
  });

  it('never overwrites existing cells and skips fully-populated rows (no fetch)', () => {
    const be = load([
      ['Done', 'x', 1, 'cat', 'desc', 'https://www.youtube.com/@Done',
        'UCdddddddddddddddddddddd', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCdddddddddddddddddddddd', true, 'https://existing/avatar.png'],
    ]);
    const summary = be.enrichChannels();
    expect(summary.processed).toBe(0);
    expect(be.calls).toHaveLength(0); // nothing fetched
    const grid = be.sheets.CHANNELS_ID._grid;
    expect(cell(grid, 1, 'channel_name')).toBe('Done'); // untouched
    expect(cell(grid, 1, 'avatar')).toBe('https://existing/avatar.png');
  });

  it('defaults a blank enabled without a network fetch when the feed already exists', () => {
    const be = load([
      ['Ready News', '', '', '', '', 'https://news2.example', '', 'https://news2.example/rss', '', 'https://news2.example/icon.png'],
    ]);
    const summary = be.enrichChannels();
    expect(summary.processed).toBe(1);
    expect(be.calls).toHaveLength(0); // name + feed + avatar already present -> no fetch
    const grid = be.sheets.CHANNELS_ID._grid;
    expect(cell(grid, 1, 'enabled')).toBe(true);
    expect(cell(grid, 1, 'feed_url')).toBe('https://news2.example/rss'); // preserved
  });

  it('article avatar: picks the LARGEST apple-touch-icon, resolved absolute', () => {
    const be = load([
      ['', '', '', '', '', 'https://paper.example', '', '', '', ''],
    ]);
    be.enrichChannels();
    const grid = be.sheets.CHANNELS_ID._grid;
    expect(cell(grid, 1, 'avatar')).toBe('https://paper.example/icons/touch-180.png?v=2&x=1');
    expect(cell(grid, 1, 'feed_url')).toBe('https://paper.example/rss.xml');
    expect(cell(grid, 1, 'channel_name')).toBe('Paper Mag');
  });

  it('article avatar: falls back to the feed <image> (https-upgraded) when the site has no touch icon', () => {
    const be = load([
      ['', '', '', '', '', 'https://mag.example', '', '', '', ''],
    ]);
    be.enrichChannels();
    const grid = be.sheets.CHANNELS_ID._grid;
    expect(cell(grid, 1, 'avatar')).toBe('https://mag.example/feed-logo.png');
  });

  it('article avatar: stays blank when neither source exists (favicon at read time)', () => {
    // news.example has no touch icon and its declared feed 404s in the mock.
    const be = load([
      ['', '', '', '', '', 'https://news.example', '', '', '', ''],
    ]);
    be.enrichChannels();
    expect(cell(be.sheets.CHANNELS_ID._grid, 1, 'avatar')).toBe('');
  });

  it('url-less article row: resolves via feed_url, filling url + avatar from the feed\'s site', () => {
    const be = load([
      ['', '', '', '', '', '', '', 'https://paper.example/rss.xml', '', ''],
    ]);
    be.enrichChannels();
    const grid = be.sheets.CHANNELS_ID._grid;
    expect(cell(grid, 1, 'url')).toBe('https://paper.example'); // from the feed's channel <link>
    expect(cell(grid, 1, 'avatar')).toBe('https://paper.example/icons/touch-180.png?v=2&x=1');
    expect(cell(grid, 1, 'channel_name')).toBe('Paper Mag');
    expect(cell(grid, 1, 'feed_url')).toBe('https://paper.example/rss.xml'); // preserved
    expect(cell(grid, 1, 'enabled')).toBe(true);
  });

  it('url-less YouTube row: fills the canonical channel url and id from feed_url', () => {
    const be = load([
      ['Teddy', '', '', '', '', '', '', `https://www.youtube.com/feeds/videos.xml?channel_id=${YT_CHANNEL_ID}`, true, ''],
    ]);
    be.enrichChannels();
    const grid = be.sheets.CHANNELS_ID._grid;
    expect(cell(grid, 1, 'url')).toBe('https://www.youtube.com/channel/' + YT_CHANNEL_ID);
    expect(cell(grid, 1, 'channel_id')).toBe(YT_CHANNEL_ID);
    expect(cell(grid, 1, 'channel_name')).toBe('Teddy'); // curated name untouched
  });
});

describe('admin enrich action (doPost)', () => {
  it('refuses without a valid admin token, and fetches nothing', () => {
    const be = load(
      [['', '', '', '', '', 'https://paper.example', '', '', '', '']],
      { adminToken: 'secret-token' },
    );
    be.doPost(postEvent({ action: 'enrich', token: 'wrong' }));
    expect(be.responses.at(-1)).toMatchObject({ status: 'error', message: 'Unauthorized' });
    expect(be.calls).toHaveLength(0);
    // Nothing was filled
    expect(cell(be.sheets.CHANNELS_ID._grid, 1, 'feed_url')).toBe('');
  });

  it('refuses when no admin_token is configured at all', () => {
    const be = load([['', '', '', '', '', 'https://paper.example', '', '', '', '']]);
    be.doPost(postEvent({ action: 'enrich', token: '' }));
    expect(be.responses.at(-1)).toMatchObject({ status: 'error', message: 'Unauthorized' });
    expect(be.calls).toHaveLength(0);
  });

  it('runs enrichChannels with a valid token and returns its summary', () => {
    const be = load(
      [['', '', '', '', '', 'https://paper.example', '', '', '', '']],
      { adminToken: 'secret-token' },
    );
    be.doPost(postEvent({ action: 'enrich', token: 'secret-token' }));

    const res = be.responses.at(-1);
    expect(res.status).toBe('ok');
    expect(res.processed).toBe(1);
    expect(res.filled).toBeGreaterThan(0);
    expect(res.results[0]).toMatchObject({ ok: true });
    // The sheet actually got the backfill
    const grid = be.sheets.CHANNELS_ID._grid;
    expect(cell(grid, 1, 'feed_url')).toBe('https://paper.example/rss.xml');
    expect(cell(grid, 1, 'avatar')).toBe('https://paper.example/icons/touch-180.png?v=2&x=1');
  });
});

describe('resolveChannelFromUrl — direct resolver', () => {
  it('rejects private/loopback/metadata hosts (SSRF guard)', () => {
    const be = load([]);
    for (const u of ['https://localhost/feed', 'http://127.0.0.1/', 'https://169.254.169.254/', 'https://192.168.1.1/rss']) {
      const r = be.resolveChannelFromUrl(u);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/safe public https/i);
    }
  });

  it('extracts the channel id from a /channel/ URL without needing the page', () => {
    const be = load([]);
    const r = be.resolveChannelFromUrl('https://www.youtube.com/channel/' + YT_CHANNEL_ID);
    // The canonical /channel/ page 404s in the mock, so name/avatar are blank,
    // but the id + feed come straight from the URL and it still resolves ok.
    expect(r.ok).toBe(true);
    expect(r.channel_id).toBe(YT_CHANNEL_ID);
    expect(r.feed_url).toBe('https://www.youtube.com/feeds/videos.xml?channel_id=' + YT_CHANNEL_ID);
  });
});

describe('scheduledFetchAllFeeds — self-serve channel adds go live without the editor', () => {
  // A recent fetch_in_progress marker makes fetchAllFeeds no-op, so these tests
  // exercise the enrichment leg of the scheduled run without the real crawl.
  const CRAWL_BUSY_META = () => [
    ['key', 'value'],
    ['log_level', 'ERROR'],
    ['fetch_in_progress', new Date().toISOString()],
  ];

  it('enriches a freshly pasted URL row before the crawl', () => {
    const be = load(
      [['', '', '', '', '', 'https://news.example', '', '', '', '']],
      { metaRows: CRAWL_BUSY_META() },
    );
    be.scheduledFetchAllFeeds();
    const grid = be.sheets.CHANNELS_ID._grid;
    expect(cell(grid, 1, 'feed_url')).toBe('https://news.example/rss.xml');
    expect(cell(grid, 1, 'channel_name')).toBe('News & Co');
    expect(cell(grid, 1, 'enabled')).toBe(true);
  });

  it('a failing enrichment is contained and never blocks the run', () => {
    const brokenChannels = {
      getDataRange: () => { throw new Error('CHANNELS unavailable'); },
    };
    const be = load([], { channelsSheet: brokenChannels, metaRows: CRAWL_BUSY_META() });
    expect(be.runScheduledEnrichment()).toBeNull();       // swallowed, reported as failed
    expect(() => be.scheduledFetchAllFeeds()).not.toThrow(); // crawl leg still reached
  });
});

describe('handleAddChannel — the password-protected add-channel form endpoint', () => {
  const ADMIN_META = () => [
    ['key', 'value'],
    ['log_level', 'ERROR'],
    ['admin_token', 'sekret-admin-token'],
    ['add_channel_password', 'sekret-add-password'],
    // A fresh marker parks the add path's inline crawl, so the tests below
    // exercise resolution/dedup without needing feed fixtures.
    ['fetch_in_progress', new Date().toISOString()],
  ];

  it('resolves a YouTube URL and appends a fully-enriched, enabled row', () => {
    const be = load([], { metaRows: ADMIN_META() });
    const res = be.handleAddChannel({ url: 'https://www.youtube.com/@WatchGuy' });

    expect(res.status).toBe('ok');
    expect(res.channel).toEqual({
      channel_name: 'Watch Guy',
      platform: 'youtube',
      feed_url: 'https://www.youtube.com/feeds/videos.xml?channel_id=' + YT_CHANNEL_ID,
      avatar: 'https://yt3.googleusercontent.com/abc=s900-c-k-c0x00ffffff-no-rj',
    });
    const grid = be.sheets.CHANNELS_ID._grid;
    expect(grid).toHaveLength(2); // headers + the new row
    expect(cell(grid, 1, 'channel_id')).toBe(YT_CHANNEL_ID);
    expect(cell(grid, 1, 'url')).toBe('https://www.youtube.com/@WatchGuy');
    expect(cell(grid, 1, 'enabled')).toBe(true);
  });

  it('crawls the new channel inline so it has content immediately', () => {
    // No fetch_in_progress marker — the crawl must actually run. ScriptApp is
    // left empty on purpose: the add path must not need a trigger (and so must
    // not need the script.scriptapp scope this deployment does not carry).
    const be = load([], {
      metaRows: [['key', 'value'], ['log_level', 'ERROR'], ['admin_token', 't']],
    });
    const res = be.handleAddChannel({ url: 'https://news.example' });

    expect(res.status).toBe('ok');
    expect(res.new_items).toBe(2);
    // Both feed items landed in Videos, attributed to the channel just added.
    const rows = be.sheets.VIDEOS_ID._grid.slice(1);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r[3]).sort()).toEqual([
      'https://news.example/first',
      'https://news.example/second',
    ]);
    expect(rows.every((r) => r[1] === 'News & Co')).toBe(true);
  });

  it('crawls ONLY the added feed, leaving other channels and the crawl bookkeeping alone', () => {
    // An existing channel whose feed would also parse. The inline crawl must
    // not touch it, must not advance the resume index, and must not stamp
    // last_fetch — that would tell handleFeed the whole catalog is fresh.
    const be = load([
      ['Paper Mag', '', 0, '', '', 'https://paper.example', '', 'https://paper.example/rss.xml', true, ''],
    ], { metaRows: [['key', 'value'], ['log_level', 'ERROR'], ['admin_token', 't']] });

    be.handleAddChannel({ url: 'https://news.example' });

    const rows = be.sheets.VIDEOS_ID._grid.slice(1);
    expect(rows.every((r) => r[1] === 'News & Co')).toBe(true);
    expect(rows.some((r) => r[3] === 'https://paper.example/a-story')).toBe(false);

    const meta = be.sheets.META_ID._grid;
    expect(meta.find((r) => r[0] === 'last_fetch')).toBeUndefined();
    expect(meta.find((r) => r[0] === 'crawl_resume_index')).toBeUndefined();
  });

  it('still adds the channel when a full crawl is already running', () => {
    // fetch_in_progress is fresh, so fetchAllFeeds' one-crawl-at-a-time guard
    // parks the inline crawl. The row must still be saved — the 4h cycle picks
    // the content up — and the caller must not see an error.
    const be = load([], { metaRows: ADMIN_META() });
    const res = be.handleAddChannel({ url: 'https://news.example' });

    expect(res.status).toBe('ok');
    expect(res.new_items).toBe(0);
    expect(be.sheets.CHANNELS_ID._grid).toHaveLength(2); // row appended anyway
    expect(be.sheets.VIDEOS_ID._grid).toHaveLength(1);   // header only
  });

  it('refuses a duplicate (same channel id via a different URL form)', () => {
    const be = load([
      ['Watch Guy', '', '', '', '', 'https://youtube.com/c/watchguy', YT_CHANNEL_ID, 'https://www.youtube.com/feeds/videos.xml?channel_id=' + YT_CHANNEL_ID, true, ''],
    ], { metaRows: ADMIN_META() });
    const res = be.handleAddChannel({ url: 'https://www.youtube.com/@WatchGuy' });
    expect(res.status).toBe('error');
    expect(res.message).toMatch(/Already in the list as "Watch Guy"/);
    expect(be.sheets.CHANNELS_ID._grid).toHaveLength(2); // nothing appended
  });

  it('refuses a duplicate site URL despite trailing-slash/protocol differences', () => {
    const be = load([
      ['News & Co', '', '', '', '', 'http://news.example/', '', 'https://other.feed/rss', true, ''],
    ], { metaRows: ADMIN_META() });
    const res = be.handleAddChannel({ url: 'https://news.example' });
    expect(res.status).toBe('error');
    expect(res.message).toMatch(/Already in the list/);
  });

  it('reports a resolvable error for a URL with no discoverable feed', () => {
    const be = load([], { metaRows: ADMIN_META() });
    const res = be.handleAddChannel({ url: 'https://nofeed.example' });
    expect(res.status).toBe('error');
    expect(be.sheets.CHANNELS_ID._grid).toHaveLength(1); // nothing appended
  });

  it('doPost refuses a wrong password without touching the sheet', () => {
    const be = load([], { metaRows: ADMIN_META() });
    be.doPost(postEvent({ action: 'addChannel', url: 'https://news.example', token: 'wrong' }));
    expect(be.responses.at(-1)).toMatchObject({ status: 'error', message: 'Wrong password' });
    expect(be.sheets.CHANNELS_ID._grid).toHaveLength(1);
    expect(be.calls).toHaveLength(0); // not even resolved — auth comes first
  });

  it('doPost adds the channel with the add-channel password', () => {
    const be = load([], { metaRows: ADMIN_META() });
    be.doPost(postEvent({ action: 'addChannel', url: 'https://news.example', token: 'sekret-add-password' }));
    expect(be.responses.at(-1)).toMatchObject({ status: 'ok' });
    expect(cell(be.sheets.CHANNELS_ID._grid, 1, 'feed_url')).toBe('https://news.example/rss.xml');
  });

  it('the admin token does NOT unlock the form (separate secrets on purpose)', () => {
    const be = load([], { metaRows: ADMIN_META() });
    be.doPost(postEvent({ action: 'addChannel', url: 'https://news.example', token: 'sekret-admin-token' }));
    expect(be.responses.at(-1)).toMatchObject({ status: 'error', message: 'Wrong password' });
    expect(be.sheets.CHANNELS_ID._grid).toHaveLength(1);
  });

  it('fails closed when no add_channel_password row is configured', () => {
    const be = load([], {
      metaRows: [['key', 'value'], ['log_level', 'ERROR'], ['admin_token', 'sekret-admin-token']],
    });
    be.doPost(postEvent({ action: 'addChannel', url: 'https://news.example', token: '' }));
    expect(be.responses.at(-1)).toMatchObject({ status: 'error', message: 'Wrong password' });
    expect(be.sheets.CHANNELS_ID._grid).toHaveLength(1);
  });
});

describe('scheduleRefresh — the missing script.scriptapp scope is logged once, not per request', () => {
  // The real message, in both locales Google has actually served it in. The
  // scope URL is the only part it does not localize.
  const EN = 'Exception: Specified permissions are not sufficient to call ScriptApp.getProjectTriggers. Required permissions: https://www.googleapis.com/auth/script.scriptapp';
  const HE = 'Exception: ההרשאות שצוינו לא מספיקות כדי לשלוח קריאה אל ScriptApp.getProjectTriggers. ההרשאות הנדרשות: https://www.googleapis.com/auth/script.scriptapp';

  /** Loads the backend with a ScriptApp whose trigger calls throw `message`. */
  function loadThrowing(message) {
    return load([], {
      // WARN, not DEBUG: log() resolves its threshold with
      // `LOG_LEVELS[configLevel] || LOG_LEVELS.ERROR`, and LOG_LEVELS.DEBUG is
      // 0 — falsy — so a DEBUG setting silently filters at ERROR instead. WARN
      // lets both levels this suite asserts on through.
      metaRows: [['key', 'value'], ['log_level', 'WARN']],
      scriptApp: { getProjectTriggers: () => { throw new Error(message); } },
    });
  }

  const linesFrom = (be) => be.sheets.LOGS_ID._grid.slice(1).filter((r) => r[2] === 'scheduleRefresh');

  it('logs one WARN for a burst of stale-feed requests, not one per call', () => {
    const be = loadThrowing(EN);
    for (let i = 0; i < 25; i++) be.scheduleRefresh();

    const lines = linesFrom(be);
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toBe('WARN');
    expect(lines[0][3]).toMatch(/Async refresh unavailable/);
    expect(lines[0][3]).toMatch(/4h scheduled\s+crawl is unaffected|4h scheduled crawl is unaffected/);
  });

  it('recognizes the localized message too (matched on the scope URL)', () => {
    const be = loadThrowing(HE);
    be.scheduleRefresh();
    be.scheduleRefresh();

    const lines = linesFrom(be);
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toBe('WARN');
  });

  it('still ERRORs, every time, on any other failure', () => {
    const be = loadThrowing('Exception: Service Spreadsheets timed out');
    be.scheduleRefresh();
    be.scheduleRefresh();

    const lines = linesFrom(be);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l[1] === 'ERROR')).toBe(true);
    expect(lines[0][3]).toMatch(/timed out/);
  });
});
