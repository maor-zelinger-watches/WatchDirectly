/**
 * BE6 / BE7 / SEC12 — crawl write batching, the per-execution META memo, and
 * moving comment rate-limiting off the Meta config sheet into CacheService.
 *
 * Like the sibling backend tests (handlers / crawl_dedup_budget / abuse_rate_limits),
 * these eval the SHIPPED apps-script/Code.gs against in-memory Sheet / CacheService /
 * UrlFetchApp stubs and exercise the real functions — not copies.
 *
 * Coverage:
 *  - BE6: a crawl with K brand-new items performs ONE batched setValues (never a
 *    per-row appendRow) and text-formats ('@') that batched range first.
 *  - BE7: getMeta reads the whole Meta sheet exactly once per execution no matter
 *    how many times it's called, and setMeta keeps the in-memory copy correct.
 *  - SEC12: comment rate-limiting is enforced via CacheService and no rate_<email>
 *    PII row is ever appended to the Meta sheet.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');
const CLIENT_ID = SRC.match(/GOOGLE_CLIENT_ID\s*=\s*'([^']+)'/)[1];
const META_ID = SRC.match(/META:\s*'([^']+)'/)[1];
const nowSec = () => Math.floor(Date.now() / 1000);

// Patch the spreadsheet-id constants to stable test keys (mirrors the sibling
// crawl harness) so a mock SpreadsheetApp can route by id.
function patchSrc() {
  return SRC
    .replace(/CHANNELS:\s*'[^']+'/, "CHANNELS: 'CHANNELS_ID'")
    .replace(/VIDEOS:\s*'[^']+'/, "VIDEOS: 'VIDEOS_ID'")
    .replace(/META:\s*'[^']+'/, "META: 'META_ID'");
}

// ==================================================================
// BE6 — batched crawl writes
// ==================================================================

/**
 * A stateful in-memory sheet that records how it was written: appendRow calls
 * and every getRange(...).setValues() (with the '@' format flag captured just
 * before the write). Faithful getValues so the batched read-modify-write path
 * works exactly as it does against real Sheets.
 */
function makeCountingSheet(rows) {
  const grid = rows.map((r) => r.slice());
  const writes = [];
  let appendRowCalls = 0;
  return {
    _grid: grid,
    _writes: writes,
    get _appendRowCalls() { return appendRowCalls; },
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getRange: (row, col, numRows, numCols) => {
      const range = {
        _fmt: null,
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
        setNumberFormat(fmt) { this._fmt = fmt; return this; },
        setValue(v) {
          while (grid.length < row) grid.push([]);
          const r = grid[row - 1];
          while (r.length < col) r.push('');
          r[col - 1] = v;
        },
        setValues(values) {
          writes.push({ row, col, numRows: values.length, width: values[0] ? values[0].length : 0, fmt: this._fmt });
          for (let i = 0; i < values.length; i++) {
            while (grid.length < row + i) grid.push([]);
            const r = grid[row - 1 + i];
            for (let j = 0; j < values[i].length; j++) {
              while (r.length < col + j) r.push('');
              r[col - 1 + j] = values[i][j];
            }
          }
        },
      };
      return range;
    },
    appendRow: (r) => { appendRowCalls++; grid.push(r.slice()); },
    getLastRow: () => grid.length,
  };
}

// Full schema incl. the live trio so the crawl never self-adds columns.
const VIDEO_HEADERS = ['video_id', 'channel_name', 'title', 'url', 'published_at', 'fetched_at', 'tier', 'category', 'comment_count', 'vote_count', 'media_type', 'preview_image', 'view_count', 'live_status', 'scheduled_start', 'expires_at'];

/** RSS 2.0 feed with N <item> entries (distinct links -> distinct ids). */
function rssMultiArticle(items) {
  const pub = new Date().toUTCString(); // fresh -> never pruned mid-test
  const body = items.map(([link, title]) =>
    `<item><title>${title}</title><link>${link}</link><pubDate>${pub}</pubDate></item>`
  ).join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel>${body}</channel></rss>`;
}

function loadCrawl(opts) {
  const channelRows = [['channel_name', 'feed_url', 'tier', 'category', 'enabled']]
    .concat(opts.channels.map((c) => [c[0], c[1], 0, 'Heavyweights', true]));
  const videosSheet = makeCountingSheet([VIDEO_HEADERS, ...(opts.videoRows || [])]);
  const metaSheet = makeCountingSheet([['key', 'value'], ['youtube_api_key', 'test-key'], ...(opts.meta || [])]);
  const sheets = {
    CHANNELS_ID: makeCountingSheet(channelRows),
    VIDEOS_ID: videosSheet,
    META_ID: metaSheet,
  };

  const fetch = (url) => {
    if (opts.feeds[url]) {
      return { getResponseCode: () => 200, getContentText: () => opts.feeds[url] };
    }
    // og:image fetch for a new article, or unknown host.
    return { getResponseCode: () => 404, getContentText: () => '', getAllHeaders: () => ({}) };
  };

  const globals = {
    UrlFetchApp: { fetch },
    SpreadsheetApp: { openById: (id) => ({ getSheets: () => [sheets[id]], getSheetByName: () => null }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: () => '0',
      computeDigest: (_algo, str) => Array.from(String(str)).map((c) => c.charCodeAt(0)),
      // Deterministic distinct id per input. The parser derives the video id as
      // base64EncodeWebSafe(hash).replace(/[^a-zA-Z0-9]/g,'').slice(0,15), so the
      // distinguishing part must land in the FIRST 15 chars — hash the bytes to a
      // short base36 tag so distinct links get distinct ids (real crypto would).
      base64EncodeWebSafe: (bytes) => {
        var s = Array.isArray(bytes) ? bytes.join(',') : String(bytes);
        var h = 0;
        for (var i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
        return 'ID' + h.toString(36) + 'zzzzzzzzzzzzzzz';
      },
      sleep() {}, DigestAlgorithm: { MD5: 'MD5' },
    },
    Logger: { log() {} },
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
    ScriptApp: {},
    XmlService: undefined, // force parseRegex fallback (no Java XML in Node)
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  };

  const factory = new Function(...Object.keys(globals), `${patchSrc()}\nreturn { crawlAllFeeds };`);
  return { ...factory(...Object.values(globals)), videosSheet, metaSheet };
}

describe('BE6 — crawl batches new-item writes into one setValues', () => {
  it('writes K new items in ONE @-formatted setValues, with zero per-row appends', () => {
    // K channels, each serving one distinct item. The batched flush runs once
    // AFTER the whole channel loop, so all K rows accumulated across channels
    // land in a single setValues — proving the batch spans the entire crawl.
    const K = 5;
    const channels = [];
    const feeds = {};
    for (let i = 0; i < K; i++) {
      const feedUrl = `https://feed.example/${i}`;
      channels.push([`Blog ${i}`, feedUrl]);
      feeds[feedUrl] = rssMultiArticle([[`https://blog.example/post-${i}`, `Title ${i}`]]);
    }

    const be = loadCrawl({ channels, feeds, videoRows: [] });

    const res = be.crawlAllFeeds();
    expect(res.new_videos).toBe(K);

    // No per-row appendRow on the Videos sheet — the old hot path is gone.
    expect(be.videosSheet._appendRowCalls).toBe(0);

    // Exactly one batched write, K rows tall, and text-formatted first.
    const batched = be.videosSheet._writes.filter((w) => w.numRows === K);
    expect(batched).toHaveLength(1);
    expect(batched[0].fmt).toBe('@');
    expect(batched[0].width).toBe(VIDEO_HEADERS.length);
    expect(batched[0].row).toBe(2); // appended right after the header row

    // The whole crawl issued exactly one setValues on the Videos sheet.
    expect(be.videosSheet._writes).toHaveLength(1);

    // Header + K data rows now live in the sheet.
    expect(be.videosSheet._grid).toHaveLength(1 + K);
  });

  it('makes no batched write when a crawl ingests nothing new', () => {
    const be = loadCrawl({
      channels: [['Blog', 'https://feed.example/blog']],
      feeds: { 'https://feed.example/blog': rssMultiArticle([]) },
      videoRows: [],
    });
    const res = be.crawlAllFeeds();
    expect(res.new_videos).toBe(0);
    expect(be.videosSheet._appendRowCalls).toBe(0);
    expect(be.videosSheet._writes).toHaveLength(0);
  });
});

// ==================================================================
// BE7 — getMeta memoized to one Meta read per execution
// ==================================================================

/** A Meta sheet that counts full getDataRange().getValues() scans. */
function loadMetaHarness(metaRows) {
  let reads = 0;
  const grid = [['key', 'value'], ...metaRows];
  const metaSheet = {
    _grid: grid,
    getDataRange: () => ({ getValues: () => { reads++; return grid.map((r) => r.slice()); } }),
    getRange: (row, col) => ({ setValue(v) { grid[row - 1][col - 1] = v; } }),
    appendRow: (r) => grid.push(r.slice()),
    getLastRow: () => grid.length,
  };
  const globals = {
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{}' }) },
    SpreadsheetApp: { openById: () => ({ getSheets: () => [metaSheet], getSheetByName: () => null }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { getUuid: () => '0', computeDigest: () => [], base64EncodeWebSafe: () => 'x', sleep() {}, DigestAlgorithm: { MD5: 'MD5' } },
    Logger: { log() {} },
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
    ScriptApp: {}, XmlService: {},
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  };
  const factory = new Function(...Object.keys(globals), `${SRC}\nreturn { getMeta, setMeta };`);
  return { ...factory(...Object.values(globals)), grid, reads: () => reads };
}

describe('BE7 — getMeta reads the Meta sheet once per execution', () => {
  it('serves many getMeta lookups from a single full scan', () => {
    const be = loadMetaHarness([['youtube_api_key', 'k'], ['last_fetch', 't'], ['log_level', 'ERROR']]);
    expect(be.getMeta('youtube_api_key')).toBe('k');
    expect(be.getMeta('last_fetch')).toBe('t');
    expect(be.getMeta('log_level')).toBe('ERROR');
    expect(be.getMeta('youtube_api_key')).toBe('k'); // repeat lookup
    expect(be.getMeta('missing')).toBe(null);
    expect(be.reads()).toBe(1); // exactly one getDataRange scan
  });

  it('keeps the in-memory copy correct on setMeta without a re-scan on read', () => {
    const be = loadMetaHarness([['refresh_interval_hours', '6']]);
    expect(be.getMeta('refresh_interval_hours')).toBe('6'); // warms the memo (1 scan)
    be.setMeta('refresh_interval_hours', '12');             // updates existing row + memo
    const readsAfterWrite = be.reads();
    expect(be.getMeta('refresh_interval_hours')).toBe('12'); // served from memo
    expect(be.reads()).toBe(readsAfterWrite);                // no extra getMeta scan
    be.setMeta('brand_new_key', 'v');                        // appends a new row + memo
    expect(be.getMeta('brand_new_key')).toBe('v');
  });
});

// ==================================================================
// SEC12 — comment rate limiting via CacheService, no rate_ PII in Meta
// ==================================================================

function memoryCache() {
  const store = new Map();
  return {
    _store: store,
    getScriptCache: () => ({
      get: (k) => (store.has(k) ? store.get(k) : null),
      put: (k, v) => { store.set(k, v); },
      remove: (k) => { store.delete(k); },
    }),
  };
}

function blankSheet() {
  return {
    getDataRange: () => ({ getValues: () => [[]] }),
    getRange: () => ({ setValue() {}, setValues() {}, setNumberFormat() { return this; } }),
    appendRow() {},
    getLastRow: () => 0,
  };
}

const validClaims = () => ({
  aud: CLIENT_ID, iss: 'accounts.google.com', exp: nowSec() + 3600,
  email: 'user@example.com', email_verified: 'true', name: 'User', picture: 'https://x/p.jpg',
});

/** Route only the Meta id to an inspectable stateful sheet; blank everything else. */
function loadComments(cache) {
  const metaGrid = [['key', 'value']];
  const metaSheet = {
    _grid: metaGrid,
    getDataRange: () => ({ getValues: () => metaGrid.map((r) => r.slice()) }),
    getRange: (row, col) => ({ setValue(v) { metaGrid[row - 1][col - 1] = v; }, setValues() {}, setNumberFormat() { return this; } }),
    appendRow: (r) => metaGrid.push(r.slice()),
    getLastRow: () => metaGrid.length,
  };
  const globals = {
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(validClaims()) }) },
    SpreadsheetApp: { openById: (id) => ({ getSheets: () => [id === META_ID ? metaSheet : blankSheet()], getSheetByName: () => null }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { getUuid: () => '00000000-0000-0000-0000-000000000000', computeDigest: () => [], base64EncodeWebSafe: () => 'x', sleep() {}, DigestAlgorithm: { MD5: 'MD5', SHA_256: 'SHA_256' } },
    Logger: { log() {} },
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
    ScriptApp: {}, XmlService: {},
    CacheService: cache,
  };
  const factory = new Function(...Object.keys(globals), `${SRC}\nreturn { handleAddComment };`);
  return { ...factory(...Object.values(globals)), metaGrid };
}

describe('SEC12 — comment rate limiting via CacheService, no rate_ rows in Meta', () => {
  it('stamps the limiter in CacheService and appends no rate_ row to Meta', () => {
    const cache = memoryCache();
    const be = loadComments(cache);

    const first = be.handleAddComment({ videoId: 'v1', body: 'hello there', token: 't' });
    expect(first.status).toBe('ok');

    // The stamp lives in CacheService under the shared limiter's key...
    expect(cache._store.has('rl_comment_user@example.com')).toBe(true);
    // ...and NOT as a rate_<email> row in the Meta config sheet.
    expect(be.metaGrid.some((r) => String(r[0]).startsWith('rate_'))).toBe(false);
  });

  it('blocks a second comment inside the window, still writing nothing to Meta', () => {
    const cache = memoryCache();
    const be = loadComments(cache);

    expect(be.handleAddComment({ videoId: 'v1', body: 'first', token: 't' }).status).toBe('ok');
    const second = be.handleAddComment({ videoId: 'v1', body: 'second', token: 't' });
    expect(second.status).toBe('error');
    expect(second.message).toMatch(/wait/i);

    expect(be.metaGrid.some((r) => String(r[0]).startsWith('rate_'))).toBe(false);
  });
});
