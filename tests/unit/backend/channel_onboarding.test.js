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
    getRange: (row, col) => ({
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

const BLOG_HTML = `<!doctype html><html><head><title>My Blog</title></head><body></body></html>`;

const RSS_BODY = `<?xml version="1.0"?><rss version="2.0"><channel><title>My Blog</title></channel></rss>`;

function ok200(text) {
  return { getResponseCode: () => 200, getContentText: () => text, getAllHeaders: () => ({}) };
}

function load(channelRows) {
  const sheets = {
    CHANNELS_ID: makeSheet([CHANNEL_HEADERS, ...channelRows]),
    META_ID: makeSheet([['key', 'value'], ['log_level', 'ERROR']]),
  };
  const calls = [];
  const fetch = (u) => {
    calls.push(u);
    if (u === 'https://www.youtube.com/@WatchGuy') return ok200(YT_HTML);
    if (u === 'https://news.example') return ok200(NEWS_HTML);
    if (u === 'https://blog.example') return ok200(BLOG_HTML);
    if (u === 'https://blog.example/feed/') return ok200(RSS_BODY);
    return { getResponseCode: () => 404, getContentText: () => '', getAllHeaders: () => ({}) };
  };

  const globals = {
    UrlFetchApp: { fetch },
    SpreadsheetApp: { openById: (id) => ({ getSheets: () => [sheets[id]] }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { sleep() {} },
    Logger: { log() {} },
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
    ScriptApp: {},
    XmlService: undefined,
  };
  const patched = SRC
    .replace(/CHANNELS:\s*'[^']+'/, "CHANNELS: 'CHANNELS_ID'")
    .replace(/META:\s*'[^']+'/, "META: 'META_ID'");

  const names = ['enrichChannels', 'resolveChannelFromUrl'];
  const factory = new Function(...Object.keys(globals), `${patched}\nreturn { ${names.join(', ')} };`);
  return { ...factory(...Object.values(globals)), sheets, calls };
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
      ['Ready News', '', '', '', '', 'https://news2.example', '', 'https://news2.example/rss', '', ''],
    ]);
    const summary = be.enrichChannels();
    expect(summary.processed).toBe(1);
    expect(be.calls).toHaveLength(0); // name + feed already present -> no fetch
    const grid = be.sheets.CHANNELS_ID._grid;
    expect(cell(grid, 1, 'enabled')).toBe(true);
    expect(cell(grid, 1, 'feed_url')).toBe('https://news2.example/rss'); // preserved
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
