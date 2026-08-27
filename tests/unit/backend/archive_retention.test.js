/**
 * Unit tests for the BE8 retention/paging half (fix/be-archive-retention).
 *
 * Two problems closed here, against the SHIPPED Code.gs:
 *
 *  1. handleArchive cached the ENTIRE sorted archive in one cache value and
 *     re-scanned+sorted the whole tab per page once that value outgrew the
 *     cache limit. It now caches each page under its OWN bounded key (page +
 *     clamped limit), generation-stamped, so a single oversize value can no
 *     longer disable caching and a warm page serves with zero sheet reads
 *     however large the tab grows.
 *
 *  2. pruneOldVideos only ever APPENDS to the Archive tab, so it grew unbounded.
 *     pruneOldArchive is a second-stage retention that drops Archive rows past
 *     ARCHIVE_MAX_AGE_DAYS and bumps the cache generation, so a page cached
 *     before the removal becomes a miss (never serving dropped rows).
 *
 * As with the other backend tests, this evals the shipped source against
 * in-memory Sheet / CacheService / PropertiesService stubs — no reimplemented
 * copies, no temp files.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const HEADERS = ['video_id', 'channel_name', 'title', 'url', 'published_at', 'comment_count', 'vote_count', 'media_type', 'expires_at'];

/** A stateful, mutable in-memory sheet that counts full-grid reads. */
function makeSheet(rows) {
  const grid = rows.map((r) => r.slice());
  const stats = { reads: 0 };
  return {
    _grid: grid,
    _stats: stats,
    getDataRange: () => ({ getValues: () => { stats.reads++; return grid.map((r) => r.slice()); } }),
    getRange: (row, col, numRows, numCols) => ({
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
      getValues() {
        const nr = numRows || 1;
        const nc = numCols || 1;
        const out = [];
        for (let i = 0; i < nr; i++) {
          const r = grid[row - 1 + i] || [];
          const rr = [];
          for (let j = 0; j < nc; j++) rr.push(col - 1 + j < r.length ? r[col - 1 + j] : '');
          out.push(rr);
        }
        return out;
      },
      setNumberFormat() {},
    }),
    appendRow: (r) => { grid.push(r.slice()); },
    getLastRow: () => grid.length,
    getLastColumn: () => grid.reduce((m, r) => Math.max(m, r.length), 0),
    deleteRows: (rowPosition, howMany) => { grid.splice(rowPosition - 1, howMany); },
  };
}

/** A spreadsheet with a default first sheet plus named tabs (Archive). */
function makeSpreadsheet(firstSheet) {
  const tabs = {};
  return {
    _tabs: tabs,
    getSheets: () => [firstSheet],
    getSheetByName: (name) => tabs[name] || null,
    insertSheet: (name) => { tabs[name] = makeSheet([]); return tabs[name]; },
  };
}

/** CacheService with a real backing store; `onPut` can veto a write (oversize). */
function makeCache(onPut) {
  const store = {};
  return {
    _store: store,
    getScriptCache: () => ({
      get: (k) => (k in store ? store[k] : null),
      put: (k, v, ttl) => { if (onPut) onPut(k, v, ttl); store[k] = v; },
      remove: (k) => { delete store[k]; },
    }),
  };
}

/** In-memory PropertiesService so the cache generation persists across calls. */
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

/**
 * Loads the archive read + retention paths bound to a stateful Videos
 * spreadsheet (with an Archive tab), a real CacheService store, and a
 * persistent PropertiesService (where the generation lives).
 */
function loadBackend(opts = {}) {
  const live = makeSheet([HEADERS]); // live first sheet — irrelevant to the archive path
  const videosSpreadsheet = makeSpreadsheet(live);
  let archiveSheet = null;
  if (opts.archiveRows) {
    archiveSheet = makeSheet([HEADERS, ...opts.archiveRows]);
    videosSpreadsheet._tabs.Archive = archiveSheet;
  }

  const meta = makeSheet([['key', 'value']]); // empty -> log level defaults to ERROR
  const spreadsheets = {
    VIDEOS_ID: videosSpreadsheet,
    META_ID: makeSpreadsheet(meta),
    LOGS_ID: makeSpreadsheet(makeSheet([['ts', 'level', 'source', 'message']])),
  };

  const cache = opts.cache || makeCache();
  const props = opts.props || makeProps();

  const globals = {
    SpreadsheetApp: { openById: (id) => spreadsheets[id] },
    CacheService: cache,
    PropertiesService: props,
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Logger: { log() {} },
    Utilities: { sleep() {} },
    UrlFetchApp: {}, ScriptApp: {},
  };

  const patched = SRC
    .replace(/VIDEOS:\s*'[^']+'/, "VIDEOS: 'VIDEOS_ID'")
    .replace(/META:\s*'[^']+'/, "META: 'META_ID'")
    .replace(/LOGS:\s*'[^']+'/, "LOGS: 'LOGS_ID'");

  const names = [
    'handleArchive', 'readSortedArchive', 'readArchiveVideos',
    'invalidateArchive', 'pruneOldArchive', 'currentCacheGeneration',
    'ARCHIVE_CACHE_KEY', 'ARCHIVE_MAX_AGE_DAYS',
  ];
  const factory = new Function(...Object.keys(globals), `${patched}\nreturn { ${names.join(', ')} };`);
  return { ...factory(...Object.values(globals)), cache, props, videosSpreadsheet, archiveSheet };
}

const now = Date.now();
/** ageDays days old, archived VOD row. */
function arch(id, ageDays, opts = {}) {
  return [
    id, opts.channel || 'A', opts.title || id, opts.url || ('https://x/' + id),
    iso(now - ageDays * DAY), 0, 0, 'video', opts.expires_at || '',
  ];
}

describe('handleArchive — bounded per-page cache', () => {
  // Deliberately out of publish order in the sheet.
  const rows = [
    arch('ARCHOLDEST1', 300, { title: 'oldest' }),
    arch('ARCHNEWEST1', 90, { title: 'newest' }),
    arch('ARCHMIDDLE1', 200, { title: 'middle' }),
  ];

  it('serves a page newest-first, with the archive-wide total', () => {
    const be = loadBackend({ archiveRows: rows });

    const p1 = be.handleArchive({ page: 1, limit: 2 });
    expect(p1.status).toBe('ok');
    expect(p1.total).toBe(3);
    expect(p1.page).toBe(1);
    expect(p1.videos.map((v) => v.video_id)).toEqual(['ARCHNEWEST1', 'ARCHMIDDLE1']);

    const p2 = be.handleArchive({ page: 2, limit: 2 });
    expect(p2.total).toBe(3);
    expect(p2.videos.map((v) => v.video_id)).toEqual(['ARCHOLDEST1']);

    // Past the end is a clean empty page carrying the true total.
    const p3 = be.handleArchive({ page: 3, limit: 2 });
    expect(p3.videos).toEqual([]);
    expect(p3.total).toBe(3);
  });

  it('serves a warm page N without scanning/sorting the whole tab', () => {
    const be = loadBackend({ archiveRows: rows });

    // Cold: one scan builds the shared sorted list + caches page 1.
    be.handleArchive({ page: 1, limit: 2 });
    const afterWarm = be.archiveSheet._stats.reads;
    expect(afterWarm).toBe(1);

    // A repeat of the same page is served straight from its own cache entry —
    // no sheet read at all.
    const again = be.handleArchive({ page: 1, limit: 2 });
    expect(be.archiveSheet._stats.reads).toBe(afterWarm); // no additional scan
    expect(again.videos.map((v) => v.video_id)).toEqual(['ARCHNEWEST1', 'ARCHMIDDLE1']);

    // A different page in the burst reuses the shared sorted-list snapshot, so
    // the whole burst still costs just the one scan.
    be.handleArchive({ page: 2, limit: 2 });
    expect(be.archiveSheet._stats.reads).toBe(1);
  });

  it('keeps warm-page cost constant as the archive grows (per-page value is bounded)', () => {
    const readsToServeWarmPage = (size) => {
      const many = [];
      for (let i = 0; i < size; i++) many.push(arch('ARCH' + String(100000 + i), 90 + i));
      const be = loadBackend({ archiveRows: many });

      be.handleArchive({ page: 1, limit: 50 }); // warm
      const before = be.archiveSheet._stats.reads;
      be.handleArchive({ page: 1, limit: 50 }); // warm serve
      return be.archiveSheet._stats.reads - before;
    };

    // A warm page costs zero scans whether the tab holds 20 or 500 rows — the
    // per-page value never outgrows the cache the way one whole-archive value
    // would (which is what silently disabled caching before).
    expect(readsToServeWarmPage(20)).toBe(0);
    expect(readsToServeWarmPage(100)).toBe(0);
    expect(readsToServeWarmPage(500)).toBe(0);
  });

  it('never disables caching even when the whole-list value is too large to cache', () => {
    // Model CacheService rejecting an oversize value: only the big whole-archive
    // snapshot (ARCHIVE_CACHE_KEY) is refused; bounded per-page values still cache.
    const be = loadBackend({
      archiveRows: rows,
      cache: makeCache((k) => { if (k === 'archive_sorted_v1') throw new Error('value too large'); }),
    });

    be.handleArchive({ page: 1, limit: 2 }); // caches page 1 even though the full list can't cache
    const before = be.archiveSheet._stats.reads;
    const again = be.handleArchive({ page: 1, limit: 2 });
    expect(be.archiveSheet._stats.reads).toBe(before); // page still served without a scan
    expect(again.videos.map((v) => v.video_id)).toEqual(['ARCHNEWEST1', 'ARCHMIDDLE1']);
    expect(again.total).toBe(3);
    // The oversize whole-list value never stuck.
    expect(be.cache._store[be.ARCHIVE_CACHE_KEY]).toBeUndefined();
  });
});

describe('pruneOldArchive — age-based retention', () => {
  // The cap is a shipped constant; read it once so the fixture straddles it.
  const CAP = loadBackend({}).ARCHIVE_MAX_AGE_DAYS;

  it('the retention cap is larger than the live-prune window', () => {
    expect(CAP).toBeGreaterThan(60); // larger than PRUNE_AFTER_DAYS (60)
  });

  it('drops rows older than ARCHIVE_MAX_AGE_DAYS, keeps rows within the cap', () => {
    const rows = [
      arch('KEEPRECENT1', CAP - 30),  // within cap -> keep
      arch('DROPOLDEST1', CAP + 60),  // past cap  -> remove
      arch('KEEPEDGE001', CAP - 1),   // just inside -> keep
      arch('DROPOLDER01', CAP + 200), // past cap  -> remove
      arch('BADDATEROW1', 0),         // undateable -> keep
    ];
    const be = loadBackend({ archiveRows: rows });

    const removed = be.pruneOldArchive();
    expect(removed).toBe(2);

    const archive = be.videosSpreadsheet._tabs.Archive;
    expect(archive._grid[0]).toEqual(HEADERS); // header intact
    const ids = archive._grid.slice(1).map((r) => r[0]);
    expect(ids.sort()).toEqual(['BADDATEROW1', 'KEEPEDGE001', 'KEEPRECENT1'].sort());
    expect(ids).not.toContain('DROPOLDEST1');
    expect(ids).not.toContain('DROPOLDER01');
  });

  it('keeps an undateable row (can\'t be aged), mirroring pruneOldVideos', () => {
    const rows = [
      ['UNDATEROW01', 'A', 't', 'https://x/u', 'not-a-date', 0, 0, 'video', ''],
      arch('OLDDROPPED1', 9999),
    ];
    const be = loadBackend({ archiveRows: rows });
    expect(be.pruneOldArchive()).toBe(1);
    const ids = be.videosSpreadsheet._tabs.Archive._grid.slice(1).map((r) => r[0]);
    expect(ids).toEqual(['UNDATEROW01']);
  });

  it('bumps the generation so a page cached before retention becomes a miss', () => {
    const be = loadBackend({
      archiveRows: [
        arch('KEEPRECENT1', 30),
        arch('DROPOLDEST1', 100000), // far past any cap
      ],
    });

    // Warm page 1 -> cached under the current generation.
    const warm = be.handleArchive({ page: 1, limit: 10 });
    expect(warm.total).toBe(2);
    const readsAfterWarm = be.archiveSheet._stats.reads;
    // A repeat is a hit (no scan) — proves the page is genuinely cached.
    be.handleArchive({ page: 1, limit: 10 });
    expect(be.archiveSheet._stats.reads).toBe(readsAfterWarm);

    const genBefore = be.currentCacheGeneration();
    expect(be.pruneOldArchive()).toBe(1);
    const genAfter = be.currentCacheGeneration();
    expect(genAfter).toBeGreaterThan(genBefore); // retention bumped the generation

    // The previously-cached page is now a MISS (stale stamp): the next serve
    // re-scans and reflects the removal — never serving the dropped row.
    const readsBeforeReserve = be.archiveSheet._stats.reads;
    const after = be.handleArchive({ page: 1, limit: 10 });
    expect(be.archiveSheet._stats.reads).toBeGreaterThan(readsBeforeReserve); // re-scanned
    expect(after.total).toBe(1);
    expect(after.videos.map((v) => v.video_id)).toEqual(['KEEPRECENT1']);
  });

  it('is a no-op (no write, no generation bump) when nothing is past the cap', () => {
    const be = loadBackend({
      archiveRows: [arch('KEEPRECENT1', 10), arch('KEEPRECENT2', 100)],
    });
    const genBefore = be.currentCacheGeneration();
    expect(be.pruneOldArchive()).toBe(0);
    expect(be.currentCacheGeneration()).toBe(genBefore); // no invalidate
    const ids = be.videosSpreadsheet._tabs.Archive._grid.slice(1).map((r) => r[0]);
    expect(ids).toEqual(['KEEPRECENT1', 'KEEPRECENT2']);
  });

  it('returns 0 when the Archive tab does not exist yet', () => {
    const be = loadBackend({}); // no archiveRows -> no Archive tab
    expect(be.pruneOldArchive()).toBe(0);
  });
});
