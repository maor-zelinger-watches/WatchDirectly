/**
 * Unit tests for the whole-catalog cache.
 *
 * Background (2026-10-06 incident): every feed request the 50-row head could
 * not answer — cursor pages 2+, offset pages past the head, and the search
 * index's limit=100 chunks — re-read and re-sorted the entire Videos sheet.
 * One browser's first search focus fired 22 such scans; with the catalog at
 * ~2100 rows those scans were most of the ~590k executions/week that drove
 * the project to Google's simultaneous-executions limit and stalled even
 * no-op requests for 30s.
 *
 * Now getVideos, handleTopWeek and handleVideo read `readSortedCatalog()` — the
 * whole sorted catalog from CacheService — and the shared sorted-list cache
 * splits values past the 100KB/key cap into chunks. These tests eval the
 * SHIPPED Code.gs against in-memory Sheet / CacheService / PropertiesService
 * stubs, including a CacheService that enforces the real 100KB limit.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const CACHE_VALUE_CAP = 100 * 1024; // CacheService's documented per-value limit

const VHEADERS = ['video_id', 'channel_name', 'title', 'url', 'published_at', 'comment_count', 'vote_count', 'media_type', 'expires_at'];

function makeSheet(rows) {
  const grid = rows.map((r) => r.slice());
  const stats = { reads: 0 };
  return {
    _grid: grid,
    _stats: stats,
    getDataRange: () => ({ getValues: () => { stats.reads++; return grid.map((r) => r.slice()); } }),
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
    getLastColumn: () => grid.reduce((m, r) => Math.max(m, r.length), 0),
    deleteRows: (rowPosition, howMany) => { grid.splice(rowPosition - 1, howMany); },
  };
}

function makeSpreadsheet(firstSheet) {
  const tabs = {};
  return {
    _tabs: tabs,
    getSheets: () => [firstSheet],
    getSheetByName: (name) => tabs[name] || null,
    insertSheet: (name) => { tabs[name] = makeSheet([['vote_id', 'video_id', 'user_email', 'created_at']]); return tabs[name]; },
  };
}

/**
 * CacheService mock that behaves like the real one where it matters here:
 * every value is capped at 100KB (an oversize put throws), and the batch
 * methods exist only when `batch` is true — so the chunking code is exercised
 * both with putAll/getAll and with the per-key fallback.
 */
function makeCache({ batch = true, cap = CACHE_VALUE_CAP } = {}) {
  const store = {};
  const stats = { puts: 0, gets: 0, putAlls: 0, getAlls: 0 };
  const putOne = (k, v) => {
    if (typeof v !== 'string') throw new Error('value must be a string');
    if (Buffer.byteLength(v, 'utf8') > cap) throw new Error('Argument too large: value');
    store[k] = v;
  };
  const api = {
    get: (k) => { stats.gets++; return k in store ? store[k] : null; },
    put: (k, v) => { stats.puts++; putOne(k, v); },
    remove: (k) => { delete store[k]; },
  };
  if (batch) {
    api.putAll = (values) => { stats.putAlls++; for (const k of Object.keys(values)) putOne(k, values[k]); };
    api.getAll = (keys) => { stats.getAlls++; const out = {}; for (const k of keys) if (k in store) out[k] = store[k]; return out; };
  }
  return { _store: store, _stats: stats, getScriptCache: () => api };
}

function makeProps(seed = {}) {
  const store = { ...seed };
  return {
    _store: store,
    getScriptProperties: () => ({
      getProperty: (k) => (k in store ? store[k] : null),
      setProperty: (k, v) => { store[k] = String(v); },
      deleteProperty: (k) => { delete store[k]; },
    }),
  };
}

function loadBackend(opts = {}) {
  const videosSheet = makeSheet([VHEADERS, ...(opts.videoRows || [])]);
  const videosSpreadsheet = makeSpreadsheet(videosSheet);
  if (opts.archiveRows) {
    videosSpreadsheet._tabs.Archive = makeSheet([VHEADERS, ...opts.archiveRows]);
  }
  const commentsSpreadsheet = makeSpreadsheet(makeSheet([['comment_id', 'video_id', 'user_name', 'text']]));
  const customersSpreadsheet = makeSpreadsheet(makeSheet([['email', 'name']]));
  if (opts.voteRows) {
    customersSpreadsheet._tabs.Votes = makeSheet([['vote_id', 'video_id', 'user_email', 'created_at'], ...opts.voteRows]);
  }
  const meta = makeSpreadsheet(makeSheet([['key', 'value']]));
  const logs = makeSpreadsheet(makeSheet([['ts', 'level', 'source', 'message']]));
  const spreadsheets = { VIDEOS_ID: videosSpreadsheet, COMMENTS_ID: commentsSpreadsheet, CUSTOMERS_ID: customersSpreadsheet, META_ID: meta, LOGS_ID: logs };

  const cache = opts.cache || makeCache();
  const props = opts.props || makeProps();
  const globals = {
    SpreadsheetApp: { openById: (id) => spreadsheets[id] },
    CacheService: cache,
    PropertiesService: props,
    LockService: opts.lock || { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    Logger: { log() {} },
    Utilities: { sleep() {}, getUuid: () => 'uuid' },
    UrlFetchApp: {},
    ScriptApp: {},
  };
  const patched = SRC
    .replace(/VIDEOS:\s*'[^']+'/, "VIDEOS: 'VIDEOS_ID'")
    .replace(/COMMENTS:\s*'[^']+'/, "COMMENTS: 'COMMENTS_ID'")
    .replace(/CUSTOMERS:\s*'[^']+'/, "CUSTOMERS: 'CUSTOMERS_ID'")
    .replace(/META:\s*'[^']+'/, "META: 'META_ID'")
    .replace(/LOGS:\s*'[^']+'/, "LOGS: 'LOGS_ID'");
  const names = [
    'getVideos', 'handleFeed', 'handleTopWeek', 'handleVideo', 'handleArchive', 'readSortedArchive', 'readSortedCatalog',
    'readFeedHead', 'invalidateFeedHead', 'invalidateArchive', 'updateVoteCount',
    'currentCacheGeneration', 'bumpCacheGeneration',
    'readCachedSortedList', 'putCachedSortedList', 'cachePutChunked', 'cacheGetChunked', 'cachedSortedList',
    'FEED_HEAD_CACHE_KEY', 'CATALOG_CACHE_KEY', 'ARCHIVE_CACHE_KEY', 'CACHE_CHUNK_CHARS', 'FEED_HEAD_COUNT',
    'SORTED_LIST_REBUILD_LOCK_MS',
  ];
  const factory = new Function(...Object.keys(globals), `${patched}\nreturn { ${names.join(', ')} };`);
  return { ...factory(...Object.values(globals)), cache, props, videosSheet, videosSpreadsheet };
}

const now = Date.now();
function video(id, opts = {}) {
  return [
    id, opts.channel || 'A', opts.title || id, opts.url || ('https://x/' + id),
    iso(opts.at != null ? opts.at : now - 1 * DAY),
    opts.comment_count || 0, opts.vote_count || 0, 'video', opts.expires_at || '',
  ];
}
/** `n` rows, newest first by id order, each a few hundred bytes like production. */
function bigCatalog(n, { title = (i) => `Video number ${i} — a title long enough to look like production, roughly sixty chars` } = {}) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(video(`VID${String(i).padStart(8, '0')}`, { at: now - i * 60 * 1000, title: title(i) }));
  }
  return rows;
}
const ids = (vs) => vs.map((v) => v.video_id);

describe('readSortedCatalog — one scan feeds every request the head cannot answer', () => {
  it('cursor pages, deep offset pages and limit=100 search chunks share one sheet read', () => {
    const be = loadBackend({ videoRows: bigCatalog(2100) });
    const sheet = be.videosSheet;

    // Cold page 1 (head miss): one scan populates head + catalog.
    const p1 = be.getVideos(1, 10, '');
    expect(p1.videos).toHaveLength(10);
    expect(sheet._stats.reads).toBe(1);

    // The scroll: cursor pages 2..5, exactly what a cold load prefetches.
    let cursor = p1.next_cursor;
    for (let p = 2; p <= 5; p++) {
      const page = be.getVideos(p, 10, cursor);
      expect(page.videos[0].video_id).toBe(`VID${String((p - 1) * 10).padStart(8, '0')}`);
      cursor = page.next_cursor;
    }
    // The search index build: 21 offset pages of 100 past page 1.
    for (let p = 1; p <= 21; p++) {
      const chunk = be.getVideos(p, 100, '');
      expect(chunk.videos).toHaveLength(100);
      expect(chunk.total).toBe(2100);
    }
    // A Top This Week open and a deep-link lookup.
    expect(be.handleTopWeek({ limit: 10 }).videos.length).toBeGreaterThan(0);
    expect(be.handleVideo({ videoId: 'VID00001234' }).video.video_id).toBe('VID00001234');

    // Before this change every one of those 27 requests was its own full scan.
    expect(sheet._stats.reads).toBe(1);
  });

  it('a warm cursor page does not rewrite the head on every call', () => {
    const be = loadBackend({ videoRows: bigCatalog(120) });
    const p1 = be.getVideos(1, 10, '');
    const headBefore = be.cache._store[be.FEED_HEAD_CACHE_KEY];
    const putsBefore = be.cache._stats.puts;
    be.getVideos(2, 10, p1.next_cursor);
    be.getVideos(3, 10, be.getVideos(2, 10, p1.next_cursor).next_cursor);
    expect(be.cache._stats.puts).toBe(putsBefore);
    expect(be.cache._store[be.FEED_HEAD_CACHE_KEY]).toBe(headBefore);
  });

  it('repopulates a missing head from the cached catalog without a scan', () => {
    const be = loadBackend({ videoRows: bigCatalog(120) });
    be.getVideos(1, 10, '');
    delete be.cache._store[be.FEED_HEAD_CACHE_KEY]; // evicted, catalog still there
    const p1 = be.getVideos(1, 10, '');
    expect(p1.videos).toHaveLength(10);
    expect(be.videosSheet._stats.reads).toBe(1);
    expect(be.readFeedHead()).not.toBeNull();
  });

  it('a vote invalidates the catalog: the next read re-scans and shows the new count', () => {
    const be = loadBackend({
      videoRows: [video('AAAAAAAAAAA', { vote_count: 0 }), video('BBBBBBBBBBB', { at: now - 2 * DAY })],
      voteRows: [['v1', 'AAAAAAAAAAA', 'u@x', iso(now)]],
    });
    const p1 = be.getVideos(1, 1, '');
    expect(p1.videos[0].vote_count).toBe(0);
    expect(be.getVideos(2, 1, p1.next_cursor).videos[0].video_id).toBe('BBBBBBBBBBB');
    expect(be.videosSheet._stats.reads).toBe(1);

    expect(be.updateVoteCount('AAAAAAAAAAA')).toBe(1); // the recount itself reads the sheet to find the row
    expect(be.cache._store[be.CATALOG_CACHE_KEY]).toBeUndefined();
    const readsAfterVote = be.videosSheet._stats.reads;

    const after = be.getVideos(1, 1, '');
    expect(after.videos[0].vote_count).toBe(1);
    expect(be.videosSheet._stats.reads).toBe(readsAfterVote + 1); // exactly one re-scan
  });

  it('a stale-stamped catalog snapshot is a miss, never served', () => {
    const be = loadBackend({ videoRows: bigCatalog(30) });
    be.getVideos(1, 10, '');
    be.bumpCacheGeneration(); // as if a writer invalidated without the remove landing
    const cursorPage = be.getVideos(2, 10, be.getVideos(1, 10, '').next_cursor);
    expect(cursorPage.videos).toHaveLength(10);
    expect(be.videosSheet._stats.reads).toBeGreaterThanOrEqual(2);
  });

  it('an expired provisional row makes the snapshot a miss, so it is dropped on the re-scan', () => {
    const be = loadBackend({ videoRows: [video('LIVEEXPIRED', { expires_at: iso(now + 1000) }), video('REGULARVID1')] });
    // Snapshot taken while the provisional row is still valid.
    expect(ids(be.getVideos(1, 10, '').videos)).toContain('LIVEEXPIRED');
    // Force the stored snapshot's row past expiry (as time passing would).
    const raw = JSON.parse(be.cache._store[be.CATALOG_CACHE_KEY]);
    raw.videos[0].expires_at = iso(now - 1000);
    be.cache._store[be.CATALOG_CACHE_KEY] = JSON.stringify(raw);
    delete be.cache._store[be.FEED_HEAD_CACHE_KEY];
    be.videosSheet._grid[1][8] = iso(now - 1000); // the sheet row is now expired too
    const again = be.getVideos(1, 10, '');
    expect(ids(again.videos)).not.toContain('LIVEEXPIRED');
  });
});

describe('chunked CacheService values — the catalog is far past the 100KB/key cap', () => {
  it('a 2100-row catalog (~1MB) is cached in chunks and served back intact', () => {
    const be = loadBackend({ videoRows: bigCatalog(2100) });
    be.getVideos(1, 10, '');
    const manifest = be.cache._store[be.CATALOG_CACHE_KEY];
    expect(manifest.startsWith('{"__chunks"')).toBe(true);
    const n = JSON.parse(manifest).__chunks;
    expect(n).toBeGreaterThan(5);
    // Every stored value respects the cap (the mock throws otherwise — this
    // asserts the write actually went through).
    for (const v of Object.values(be.cache._store)) expect(Buffer.byteLength(v, 'utf8')).toBeLessThanOrEqual(CACHE_VALUE_CAP);
    expect(be.cache._stats.putAlls).toBe(1);

    const snap = be.readSortedCatalog();
    expect(snap.fresh).toBeUndefined(); // served from cache, not re-produced
    expect(snap.videos).toHaveLength(2100);
    expect(snap.total).toBe(2100);
    expect(snap.videos[0].video_id).toBe('VID00000000');
    expect(snap.videos[2099].video_id).toBe('VID00002099');
    expect(be.videosSheet._stats.reads).toBe(1);
  });

  it('non-ASCII titles (Hebrew, emoji) survive the byte-safe split', () => {
    const title = (i) => `סקירה מעמיקה של שעון ${i} ⌚️ — « מהדורה מוגבלת » 🧭 with a long ASCII tail to pad the row out`;
    const be = loadBackend({ videoRows: bigCatalog(1200, { title }) });
    be.getVideos(1, 10, '');
    expect(be.cache._store[be.CATALOG_CACHE_KEY].startsWith('{"__chunks"')).toBe(true);
    const snap = be.readSortedCatalog();
    expect(snap.videos).toHaveLength(1200);
    expect(snap.videos[7].title).toBe(title(7));
    expect(snap.videos[1199].title).toBe(title(1199));
  });

  it('falls back to per-key put/get when the cache has no putAll/getAll', () => {
    const be = loadBackend({ videoRows: bigCatalog(2100), cache: makeCache({ batch: false }) });
    be.getVideos(1, 10, '');
    expect(be.cache._store[be.CATALOG_CACHE_KEY].startsWith('{"__chunks"')).toBe(true);
    const chunk = be.getVideos(13, 100, '');
    expect(chunk.videos).toHaveLength(100);
    expect(chunk.videos[0].video_id).toBe('VID00001200');
    expect(be.videosSheet._stats.reads).toBe(1);
  });

  it('a missing chunk makes the whole value a miss (re-scan), never a truncated catalog', () => {
    const be = loadBackend({ videoRows: bigCatalog(2100) });
    be.getVideos(1, 10, '');
    const manifest = JSON.parse(be.cache._store[be.CATALOG_CACHE_KEY]);
    const victim = `${be.CATALOG_CACHE_KEY}.${manifest.tag}.${manifest.__chunks - 1}`;
    expect(be.cache._store[victim]).toBeTruthy();
    delete be.cache._store[victim];

    const chunk = be.getVideos(21, 100, '');
    expect(chunk.videos).toHaveLength(100);
    expect(chunk.total).toBe(2100);
    expect(be.videosSheet._stats.reads).toBe(2);
    expect(be.cache._store[victim]).toBeTruthy(); // re-populated
  });

  it('chunks are keyed by generation, so a superseded snapshot can never be stitched into a new one', () => {
    const be = loadBackend({ videoRows: bigCatalog(2100) });
    be.getVideos(1, 10, '');
    const m1 = JSON.parse(be.cache._store[be.CATALOG_CACHE_KEY]);
    be.invalidateFeedHead();
    be.getVideos(1, 10, '');
    const m2 = JSON.parse(be.cache._store[be.CATALOG_CACHE_KEY]);
    expect(m2.tag).not.toBe(m1.tag);
    expect(be.cache._store[`${be.CATALOG_CACHE_KEY}.${m1.tag}.0`]).toBeTruthy(); // old chunks just age out
    expect(be.cache._store[`${be.CATALOG_CACHE_KEY}.${m2.tag}.0`]).toBeTruthy();
  });

  it('small values are stored exactly as before (no manifest, no escaping)', () => {
    const be = loadBackend({ videoRows: [video('AAAAAAAAAAA'), video('BBBBBBBBBBB', { at: now - 2 * DAY })] });
    be.getVideos(1, 10, '');
    const head = be.cache._store[be.FEED_HEAD_CACHE_KEY];
    expect(head.startsWith('{"videos"')).toBe(true);
    expect(JSON.parse(head).videos).toHaveLength(2);
    expect(JSON.parse(be.cache._store[be.CATALOG_CACHE_KEY]).total).toBe(2);
  });

  it('the sorted archive — also past the cap in production — now actually caches', () => {
    const be = loadBackend({ videoRows: [video('AAAAAAAAAAA')], archiveRows: bigCatalog(2800).map((r) => { r[4] = iso(now - 200 * DAY - Math.random() * DAY); return r; }) });
    const archive = be.videosSpreadsheet._tabs.Archive;
    for (let p = 1; p <= 28; p++) expect(be.handleArchive({ page: p, limit: 100 }).videos).toHaveLength(100);
    expect(archive._stats.reads).toBe(1);
    expect(be.cache._store[be.ARCHIVE_CACHE_KEY].startsWith('{"__chunks"')).toBe(true);
  });

  it('cachePutChunked/cacheGetChunked round-trip arbitrary JSON at the boundary sizes', () => {
    const be = loadBackend();
    const cache = be.cache.getScriptCache();
    const exact = JSON.stringify({ s: 'x'.repeat(be.CACHE_CHUNK_CHARS - 8) });
    expect(exact.length).toBe(be.CACHE_CHUNK_CHARS);
    be.cachePutChunked(cache, 'k1', exact, 60, 0);
    expect(be.cache._store.k1).toBe(exact); // fits: stored verbatim
    const over = JSON.stringify({ s: 'y'.repeat(be.CACHE_CHUNK_CHARS * 2 + 5) });
    be.cachePutChunked(cache, 'k2', over, 60, 3);
    expect(JSON.parse(be.cache._store.k2).__chunks).toBe(3);
    expect(be.cacheGetChunked(cache, 'k2')).toBe(over);
    expect(be.cacheGetChunked(cache, 'nope')).toBeNull();
  });
});

/**
 * A LockService stub that records every waitLock/releaseLock and can run a
 * hook INSIDE waitLock — standing in for "another execution held the lock and
 * populated the cache while we waited", the whole point of the guard.
 */
function recordingLock({ onWait, throwOnWait = false } = {}) {
  const stats = { waits: 0, releases: 0, timeouts: [] };
  const lock = {
    waitLock(ms) {
      stats.waits++;
      stats.timeouts.push(ms);
      if (throwOnWait) throw new Error('Lock timeout: another process was holding the lock for too long.');
      if (onWait) onWait();
    },
    tryLock: () => true,
    releaseLock() { stats.releases++; },
  };
  return { _stats: stats, getScriptLock: () => lock };
}

describe('cachedSortedList — stampede guard (2026-10-03..08 "Too many simultaneous invocations: Spreadsheets")', () => {
  it('a miss takes the script lock, re-checks the cache, and skips the scan when a holder populated it', () => {
    // Everything that landed on the same miss used to scan the sheet itself.
    // Now the first one scans under the lock; the rest find the snapshot on
    // their post-lock re-check and never touch the Spreadsheet service.
    let be;
    const lock = recordingLock({
      onWait: () => {
        // "The execution ahead of us" finishes its rebuild while we wait.
        be.putCachedSortedList(be.CATALOG_CACHE_KEY, 300, {
          videos: [{ video_id: 'FROM-HOLDER', title: 'FROM-HOLDER', published_at: iso(now - DAY), media_type: 'video' }], total: 1,
        }, be.currentCacheGeneration());
      },
    });
    be = loadBackend({ videoRows: bigCatalog(50), lock });

    const got = be.readSortedCatalog();
    expect(got.videos.map((v) => v.video_id)).toEqual(['FROM-HOLDER']);
    expect(got.fresh).toBeUndefined();          // served, not produced
    expect(be.videosSheet._stats.reads).toBe(0); // no scan at all
    expect(lock._stats.waits).toBe(1);
    expect(lock._stats.releases).toBe(1);
    expect(lock._stats.timeouts).toEqual([be.SORTED_LIST_REBUILD_LOCK_MS]);
  });

  it('a genuine miss scans once under the lock and releases it', () => {
    const lock = recordingLock();
    const be = loadBackend({ videoRows: bigCatalog(50), lock });

    const got = be.readSortedCatalog();
    expect(got.videos).toHaveLength(50);
    expect(got.fresh).toBe(true);
    expect(be.videosSheet._stats.reads).toBe(1);
    expect(lock._stats.waits).toBe(1);
    expect(lock._stats.releases).toBe(1);
  });

  it('a hit never touches the lock', () => {
    const lock = recordingLock();
    const be = loadBackend({ videoRows: bigCatalog(50), lock });
    be.readSortedCatalog(); // populate
    be.readSortedCatalog();
    be.getVideos(3, 10, '');
    be.handleTopWeek({ limit: 10 });
    expect(be.videosSheet._stats.reads).toBe(1);
    expect(lock._stats.waits).toBe(1); // only the populate waited
  });

  it('contended past the bound, the request scans unshared — never worse than before the guard', () => {
    const lock = recordingLock({ throwOnWait: true });
    const be = loadBackend({ videoRows: bigCatalog(50), lock });

    const got = be.readSortedCatalog();
    expect(got.videos).toHaveLength(50);
    expect(got.fresh).toBe(true);
    expect(be.videosSheet._stats.reads).toBe(1);
    expect(lock._stats.waits).toBe(1);
    expect(lock._stats.releases).toBe(0); // never held, so never released
  });

  it('releases the lock when the scan itself throws', () => {
    const lock = recordingLock();
    const be = loadBackend({ videoRows: bigCatalog(5), lock });
    be.videosSheet.getDataRange = () => { throw new Error('Too many simultaneous invocations: Spreadsheets'); };

    expect(() => be.readSortedCatalog()).toThrow(/simultaneous invocations/);
    expect(lock._stats.waits).toBe(1);
    expect(lock._stats.releases).toBe(1);
  });

  it('the bound is well under the 6-minute execution limit and well over a normal scan', () => {
    const be = loadBackend({ videoRows: [] });
    expect(be.SORTED_LIST_REBUILD_LOCK_MS).toBeGreaterThanOrEqual(10000);
    expect(be.SORTED_LIST_REBUILD_LOCK_MS).toBeLessThan(6 * 60 * 1000);
  });
});
