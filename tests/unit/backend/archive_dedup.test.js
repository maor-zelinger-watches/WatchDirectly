/**
 * Archive duplication loop (branch fix/be-archive-dedup), against the SHIPPED
 * Code.gs.
 *
 * The bug: crawlAllFeeds deduped incoming feed items against the LIVE Videos
 * sheet only. A slow channel's ~15-entry RSS window reaches past
 * PRUNE_AFTER_DAYS, so its older items live in the Archive tab — every crawl
 * re-ingested them as "new" and end-of-crawl pruning re-archived them, minting
 * one duplicate Archive row per item per crawl (~9x duplication in production).
 *
 * Closed from both ends:
 *  1. crawlAllFeeds now seeds its id/url dedup sets from the Archive tab
 *     (two bounded column reads), so an archived item is skipped at ingest.
 *  2. pruneOldArchive now also collapses duplicate rows (keyed like
 *     dedupeByUrl: url, falling back to id; most-engaged copy wins), so the
 *     existing production duplicates self-heal on the next crawl — no manual
 *     cleanup function to run.
 *  3. The Archive writes ('append in pruneOldVideos, rewrite in
 *     pruneOldArchive) text-format ('@') their ranges first, so a
 *     formula-shaped title/url stays literal text instead of re-arming as a
 *     live formula (the guard the live-sheet flush already had).
 *
 * Like the sibling backend tests, this evals the real apps-script/Code.gs
 * against in-memory Sheet / Cache / Properties stubs — no copies.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const now = Date.now();

const VIDEO_HEADERS = ['video_id', 'channel_name', 'title', 'url', 'published_at', 'fetched_at', 'tier', 'category', 'comment_count', 'vote_count', 'media_type', 'preview_image', 'view_count', 'live_status', 'scheduled_start', 'expires_at'];

/**
 * Stateful in-memory sheet. Every setValues via getRange is recorded in
 * `_writes` with whether setNumberFormat('@') was applied to that range first,
 * so tests can assert the formula-injection guard on archive writes.
 */
function makeSheet(rows) {
  const grid = rows.map((r) => r.slice());
  const writes = [];
  return {
    _grid: grid,
    _writes: writes,
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getRange(row, col, numRows, numCols) {
      let formatted = false;
      return {
        getValues() {
          const nr = numRows || 1;
          const nc = numCols || 1;
          const out = [];
          for (let i = 0; i < nr; i++) {
            const r = grid[row - 1 + i] || [];
            const rr = [];
            for (let j = 0; j < nc; j++) rr.push(r[col - 1 + j] !== undefined ? r[col - 1 + j] : '');
            out.push(rr);
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
          writes.push({ row, col, rows: values.length, formatted });
        },
        setNumberFormat() { formatted = true; },
      };
    },
    appendRow: (r) => { grid.push(r.slice()); },
    getLastRow: () => grid.length,
    getLastColumn: () => grid.reduce((m, r) => Math.max(m, r.length), 0),
    deleteRows: (rowPosition, howMany) => { grid.splice(rowPosition - 1, howMany); },
  };
}

/** A spreadsheet with a default first sheet plus named tabs (Archive). */
function makeSpreadsheet(firstSheet, tabs = {}) {
  return {
    _tabs: tabs,
    getSheets: () => [firstSheet],
    getSheetByName: (name) => tabs[name] || null,
    insertSheet: (name) => { tabs[name] = makeSheet([]); return tabs[name]; },
  };
}

function makeCache() {
  const store = {};
  return {
    _store: store,
    getScriptCache: () => ({
      get: (k) => (k in store ? store[k] : null),
      put: (k, v) => { store[k] = v; },
      remove: (k) => { delete store[k]; },
    }),
  };
}

function makeProps() {
  const store = {};
  return {
    _store: store,
    getScriptProperties: () => ({
      getProperty: (k) => (k in store ? store[k] : null),
      setProperty: (k, v) => { store[k] = String(v); },
      deleteProperty: (k) => { delete store[k]; },
    }),
  };
}

/**
 * @param opts.channels    array of [name, feedUrl]
 * @param opts.feeds       map feedUrl -> RSS xml
 * @param opts.broadcast   map youtubeId -> { status, scheduled }
 * @param opts.videoRows   pre-seeded LIVE Videos rows (no header)
 * @param opts.archiveRows pre-seeded Archive tab rows (no header; tab absent when omitted)
 */
function loadBackend(opts = {}) {
  const liveSheet = makeSheet([VIDEO_HEADERS, ...(opts.videoRows || [])]);
  const tabs = {};
  if (opts.archiveRows) tabs.Archive = makeSheet([VIDEO_HEADERS, ...opts.archiveRows]);
  const videosSpreadsheet = makeSpreadsheet(liveSheet, tabs);

  const channelRows = [['channel_name', 'feed_url', 'tier', 'category', 'enabled']]
    .concat((opts.channels || []).map((c) => [c[0], c[1], 0, 'Heavyweights', true]));
  const metaSheet = makeSheet([['key', 'value'], ['youtube_api_key', 'test-key']]);

  const spreadsheets = {
    CHANNELS_ID: makeSpreadsheet(makeSheet(channelRows)),
    VIDEOS_ID: videosSpreadsheet,
    META_ID: makeSpreadsheet(metaSheet),
    LOGS_ID: makeSpreadsheet(makeSheet([['ts', 'level', 'source', 'message']])),
  };

  const fetch = (url) => {
    if (opts.feeds && opts.feeds[url]) {
      return { getResponseCode: () => 200, getContentText: () => opts.feeds[url] };
    }
    if (url.indexOf('googleapis.com/youtube') !== -1) {
      const idMatch = url.match(/[?&]id=([^&]+)/);
      const ids = idMatch ? decodeURIComponent(idMatch[1]).split(',') : [];
      const items = ids.filter((id) => opts.broadcast && opts.broadcast[id]).map((id) => ({
        id,
        snippet: { liveBroadcastContent: opts.broadcast[id].status },
        liveStreamingDetails: opts.broadcast[id].scheduled ? { scheduledStartTime: opts.broadcast[id].scheduled } : {},
      }));
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ items }) };
    }
    // og:image fetch for a genuinely-new article, or unknown host.
    return { getResponseCode: () => 404, getContentText: () => '', getAllHeaders: () => ({}) };
  };

  const cache = makeCache();
  const props = makeProps();
  const globals = {
    UrlFetchApp: { fetch },
    SpreadsheetApp: { openById: (id) => spreadsheets[id] },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: () => '0', computeDigest: () => [1, 2, 3], base64EncodeWebSafe: () => 'HASHEDID0000000',
      sleep() {}, DigestAlgorithm: { MD5: 'MD5' },
    },
    Logger: { log() {} },
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
    ScriptApp: {},
    XmlService: undefined, // force parseRegex fallback (no Java XML runtime)
    CacheService: cache,
    PropertiesService: props,
  };

  const patched = SRC
    .replace(/CHANNELS:\s*'[^']+'/, "CHANNELS: 'CHANNELS_ID'")
    .replace(/VIDEOS:\s*'[^']+'/, "VIDEOS: 'VIDEOS_ID'")
    .replace(/META:\s*'[^']+'/, "META: 'META_ID'")
    .replace(/LOGS:\s*'[^']+'/, "LOGS: 'LOGS_ID'");

  const names = ['crawlAllFeeds', 'pruneOldVideos', 'pruneOldArchive', 'currentCacheGeneration'];
  const factory = new Function(...Object.keys(globals), `${patched}\nreturn { ${names.join(', ')} };`);
  return { ...factory(...Object.values(globals)), liveSheet, videosSpreadsheet, cache, props };
}

function rssItem(link, title, ageDays) {
  return `<?xml version="1.0"?><rss version="2.0"><channel>
    <item><title>${title}</title><link>${link}</link>
    <pubDate>${new Date(now - ageDays * DAY).toUTCString()}</pubDate></item>
  </channel></rss>`;
}

/** An Archive/live row for `id`, published ageDays ago. */
function videoRow(id, url, ageDays, opts = {}) {
  return [
    id, opts.channel || 'C1', opts.title || id, url, iso(now - ageDays * DAY), iso(now - ageDays * DAY),
    0, 'Heavyweights', opts.comment_count || 0, opts.vote_count || 0,
    opts.media_type || 'video', '', 0, 'none', '', '',
  ];
}

describe('crawl dedups against the Archive tab', () => {
  it('skips a feed item whose id/url live only in the archive (the duplication loop)', () => {
    const YT_URL = 'https://www.youtube.com/watch?v=AAAAAAAAAAA';
    const be = loadBackend({
      channels: [['C1', 'https://feed.example/c1']],
      // The slow channel's feed still serves a 90-day-old item that has long
      // been archived (>PRUNE_AFTER_DAYS=60), and the live sheet is empty.
      feeds: { 'https://feed.example/c1': rssItem(YT_URL, 'old vid', 90) },
      broadcast: { AAAAAAAAAAA: { status: 'none' } },
      archiveRows: [videoRow('AAAAAAAAAAA', YT_URL, 90)],
    });

    const res = be.crawlAllFeeds();
    expect(res.new_videos).toBe(0);
    // Live sheet untouched (header only) — pre-fix the item was appended here,
    // then end-of-crawl pruning moved it into the archive as a duplicate.
    expect(be.liveSheet._grid).toHaveLength(1);
    // Archive unchanged: header + the ONE original row. This is the loop dead.
    expect(be.videosSpreadsheet._tabs.Archive._grid).toHaveLength(2);
  });

  it('skips an archived article by URL even when its id differs (re-hashed id)', () => {
    const ARTICLE_URL = 'https://blog.example/post-1';
    const be = loadBackend({
      channels: [['Blog', 'https://feed.example/blog']],
      feeds: { 'https://feed.example/blog': rssItem(ARTICLE_URL, 'same post, new id', 90) },
      // Archived under an OLD id scheme; the regex parse path now derives
      // 'HASHEDID0000000' for the same link, so only URL dedup can catch it.
      archiveRows: [videoRow('OLDARTICLEID', ARTICLE_URL, 90, { media_type: 'article' })],
    });

    const res = be.crawlAllFeeds();
    expect(res.new_videos).toBe(0);
    expect(be.liveSheet._grid).toHaveLength(1);
    expect(be.videosSpreadsheet._tabs.Archive._grid).toHaveLength(2);
  });

  it('still ingests a genuinely new item when an Archive tab exists', () => {
    const be = loadBackend({
      channels: [['C1', 'https://feed.example/c1']],
      feeds: { 'https://feed.example/c1': rssItem('https://www.youtube.com/watch?v=BBBBBBBBBBB', 'fresh', 5) },
      broadcast: { BBBBBBBBBBB: { status: 'none' } },
      archiveRows: [videoRow('AAAAAAAAAAA', 'https://www.youtube.com/watch?v=AAAAAAAAAAA', 90)],
    });

    const res = be.crawlAllFeeds();
    expect(res.new_videos).toBe(1);
    expect(be.liveSheet._grid).toHaveLength(2);
    expect(be.liveSheet._grid[1][0]).toBe('BBBBBBBBBBB');
    expect(be.videosSpreadsheet._tabs.Archive._grid).toHaveLength(2); // untouched
  });

  it('crawls normally when no Archive tab exists yet', () => {
    const be = loadBackend({
      channels: [['C1', 'https://feed.example/c1']],
      feeds: { 'https://feed.example/c1': rssItem('https://www.youtube.com/watch?v=BBBBBBBBBBB', 'fresh', 5) },
      broadcast: { BBBBBBBBBBB: { status: 'none' } },
      // no archiveRows -> getSheetByName('Archive') returns null
    });
    const res = be.crawlAllFeeds();
    expect(res.new_videos).toBe(1);
  });
});

describe('pruneOldArchive collapses duplicate rows (self-healing)', () => {
  it('keeps ONE copy per url — the most-engaged one — and reports the collapse', () => {
    const URL = 'https://www.youtube.com/watch?v=AAAAAAAAAAA';
    const be = loadBackend({
      archiveRows: [
        videoRow('AAAAAAAAAAA', URL, 90),                                     // engagement 0
        videoRow('AAAAAAAAAAA', URL, 90, { vote_count: 5, comment_count: 2 }), // most engaged
        videoRow('AAAAAAAAAAA', URL, 90, { vote_count: 2 }),
        videoRow('DDDDDDDDDDD', 'https://x/DDDDDDDDDDD', 100),                // distinct — kept
      ],
    });

    const genBefore = be.currentCacheGeneration();
    expect(be.pruneOldArchive()).toBe(2); // two duplicate copies removed

    const grid = be.videosSpreadsheet._tabs.Archive._grid;
    expect(grid).toHaveLength(3); // header + 2 unique rows
    const survivor = grid.slice(1).find((r) => r[0] === 'AAAAAAAAAAA');
    expect(survivor[9]).toBe(5); // vote_count of the kept copy
    expect(survivor[8]).toBe(2); // comment_count of the kept copy
    expect(grid.slice(1).map((r) => r[0]).sort()).toEqual(['AAAAAAAAAAA', 'DDDDDDDDDDD']);

    // The tab changed — cached archive pages must go stale.
    expect(be.currentCacheGeneration()).toBeGreaterThan(genBefore);
  });

  it('counts age-retired rows and collapsed duplicates together', () => {
    const URL = 'https://x/AAAAAAAAAAA';
    const be = loadBackend({
      archiveRows: [
        videoRow('AAAAAAAAAAA', URL, 90),
        videoRow('AAAAAAAAAAA', URL, 90), // duplicate -> collapsed
        videoRow('OLDRETIRED1', 'https://x/OLDRETIRED1', 400), // past 365d cap -> retired
        videoRow('KEEPDISTNC1', 'https://x/KEEPDISTNC1', 120),
      ],
    });
    expect(be.pruneOldArchive()).toBe(2); // 1 retired + 1 collapsed
    const ids = be.videosSpreadsheet._tabs.Archive._grid.slice(1).map((r) => r[0]).sort();
    expect(ids).toEqual(['AAAAAAAAAAA', 'KEEPDISTNC1']);
  });

  it('never merges rows that have neither url nor id', () => {
    const bare = (title) => ['', 'C1', title, '', iso(now - 90 * DAY), '', 0, 'x', 0, 0, 'video', '', 0, 'none', '', ''];
    const be = loadBackend({ archiveRows: [bare('one'), bare('two')] });
    expect(be.pruneOldArchive()).toBe(0); // unkeyable -> both kept, no rewrite
    expect(be.videosSpreadsheet._tabs.Archive._grid).toHaveLength(3);
  });

  it('remains a no-op (no rewrite, no generation bump) on a clean archive', () => {
    const be = loadBackend({
      archiveRows: [
        videoRow('AAAAAAAAAAA', 'https://x/AAAAAAAAAAA', 90),
        videoRow('BBBBBBBBBBB', 'https://x/BBBBBBBBBBB', 120),
      ],
    });
    const genBefore = be.currentCacheGeneration();
    expect(be.pruneOldArchive()).toBe(0);
    expect(be.currentCacheGeneration()).toBe(genBefore);
    expect(be.videosSpreadsheet._tabs.Archive._writes).toHaveLength(0);
  });
});

describe("archive writes are text-formatted ('@') against formula injection", () => {
  it('pruneOldVideos formats the archive append range before writing', () => {
    // A >60d row with a formula-shaped title, due to be archived.
    const be = loadBackend({
      videoRows: [videoRow('EVILROW0001', 'https://x/EVILROW0001', 90, { title: '=IMPORTXML("https://evil","//a")' })],
    });
    expect(be.pruneOldVideos()).toBe(1);
    const archive = be.videosSpreadsheet._tabs.Archive;
    expect(archive._grid).toHaveLength(2); // header + archived row
    const appendWrite = archive._writes.find((w) => w.row === 2);
    expect(appendWrite).toBeDefined();
    expect(appendWrite.formatted).toBe(true); // '@' applied before setValues
  });

  it('pruneOldArchive formats the survivor rewrite range before writing', () => {
    const URL = 'https://x/AAAAAAAAAAA';
    const be = loadBackend({
      archiveRows: [videoRow('AAAAAAAAAAA', URL, 90), videoRow('AAAAAAAAAAA', URL, 90)],
    });
    expect(be.pruneOldArchive()).toBe(1);
    const rewrite = be.videosSpreadsheet._tabs.Archive._writes.find((w) => w.row === 2);
    expect(rewrite).toBeDefined();
    expect(rewrite.formatted).toBe(true);
  });
});
