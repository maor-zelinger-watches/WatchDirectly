/**
 * Unit test for the archive read path (backend `archive` action).
 *
 * pruneOldVideos moves aged-out videos into an "Archive" tab; handleArchive
 * serves them, offset-paginated and newest-first, so the frontend's
 * full-history search/favorites index can reach back past the live window.
 * This pins down pagination, the newest-first order, the empty-archive case,
 * and the read-through cache (one sheet scan per burst, dropped on invalidate)
 * — against the SHIPPED Code.gs.
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

/** In-memory sheet that counts full-grid reads, so we can prove the cache. */
function makeSheet(rows) {
  const grid = rows.map((r) => r.slice());
  const stats = { reads: 0 };
  return {
    _grid: grid,
    _stats: stats,
    getDataRange: () => ({ getValues: () => { stats.reads++; return grid.map((r) => r.slice()); } }),
  };
}

function makeSpreadsheet(firstSheet, named) {
  return {
    getSheets: () => [firstSheet],
    getSheetByName: (name) => named[name] || null,
  };
}

/** CacheService mock with a real backing store, so read-through/invalidate work. */
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

/** archiveRows: array of data rows (no header). No tab at all when null. */
function loadArchive(archiveRows) {
  const live = makeSheet([HEADERS]); // live sheet — irrelevant here
  const named = {};
  let archiveSheet = null;
  if (archiveRows !== null) {
    archiveSheet = makeSheet([HEADERS, ...archiveRows]);
    named.Archive = archiveSheet;
  }
  const videosSpreadsheet = makeSpreadsheet(live, named);
  const cache = makeCache();

  const globals = {
    SpreadsheetApp: { openById: () => videosSpreadsheet },
    CacheService: cache,
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Logger: { log() {} },
    Utilities: {}, UrlFetchApp: {}, ScriptApp: {},
  };

  const patched = SRC.replace(/VIDEOS:\s*'[^']+'/, "VIDEOS: 'VIDEOS_ID'");
  const names = ['handleArchive', 'invalidateArchive', 'readArchiveVideos'];
  const factory = new Function(...Object.keys(globals), `${patched}\nreturn { ${names.join(', ')} };`);
  return { ...factory(...Object.values(globals)), cache, archiveSheet };
}

describe('handleArchive', () => {
  const now = Date.now();
  // Three archived videos, deliberately out of order in the sheet.
  const rows = [
    ['ARCHOLDEST1', 'A', 'oldest', 'https://x/1', iso(now - 300 * DAY), 0, 0, 'video', ''],
    ['ARCHNEWEST1', 'B', 'newest', 'https://x/2', iso(now - 90 * DAY), 0, 0, 'video', ''],
    ['ARCHMIDDLE1', 'C', 'middle', 'https://x/3', iso(now - 200 * DAY), 0, 0, 'video', ''],
  ];

  it('serves the archive newest-first, offset-paginated', () => {
    const be = loadArchive(rows);

    const p1 = be.handleArchive({ page: 1, limit: 2 });
    expect(p1.status).toBe('ok');
    expect(p1.total).toBe(3);
    expect(p1.videos.map((v) => v.video_id)).toEqual(['ARCHNEWEST1', 'ARCHMIDDLE1']);

    const p2 = be.handleArchive({ page: 2, limit: 2 });
    expect(p2.total).toBe(3);
    expect(p2.videos.map((v) => v.video_id)).toEqual(['ARCHOLDEST1']);

    // Past the end is a clean empty page, not an error.
    const p3 = be.handleArchive({ page: 3, limit: 2 });
    expect(p3.videos).toEqual([]);
    expect(p3.total).toBe(3);
  });

  it('returns an empty archive when the tab does not exist', () => {
    const be = loadArchive(null);
    const res = be.handleArchive({ page: 1, limit: 500 });
    expect(res).toMatchObject({ status: 'ok', total: 0 });
    expect(res.videos).toEqual([]);
  });

  it('reads the sheet once across a multi-page burst, and re-reads after invalidate', () => {
    const be = loadArchive(rows);

    be.handleArchive({ page: 1, limit: 2 });
    be.handleArchive({ page: 2, limit: 2 });
    // Both pages served from one scan — the sort is cached whole.
    expect(be.archiveSheet._stats.reads).toBe(1);

    be.invalidateArchive();
    be.handleArchive({ page: 1, limit: 2 });
    expect(be.archiveSheet._stats.reads).toBe(2);
  });

  it('drops an archived premiere whose expiry has passed (shared normalizer)', () => {
    const expired = [
      ['ARCHPERMVOD', 'A', 'vod', 'https://x/9', iso(now - 100 * DAY), 0, 0, 'video', ''],
      ['ARCHDEADPRE', 'A', 'never-aired', 'https://x/8', iso(now - 100 * DAY), 0, 0, 'video', iso(now - 50 * DAY)],
    ];
    const be = loadArchive(expired);
    const res = be.handleArchive({ page: 1, limit: 10 });
    expect(res.videos.map((v) => v.video_id)).toEqual(['ARCHPERMVOD']);
  });
});
