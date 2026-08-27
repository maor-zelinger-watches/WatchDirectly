/**
 * Unit tests for the cache-generation race fix (findings BE2 + BE8 cache half).
 *
 * The three cached sorted lists (feed head, Top-This-Week, archive) now share
 * one gen-validated read/populate path. A monotonic generation lives in a Script
 * Property; every cached payload is stamped with the generation current when its
 * source sheet was read. Each invalidate* bumps the generation, so:
 *   - a read that started before a concurrent invalidate can no longer re-install
 *     its pre-invalidate snapshot for the full TTL (its late put is refused), and
 *   - a payload somehow left in the cache under an older generation is treated as
 *     a miss on the next read (never served stale).
 *
 * As with the other backend tests, this evals the SHIPPED Code.gs against
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

const VHEADERS = ['video_id', 'channel_name', 'title', 'url', 'published_at', 'comment_count', 'vote_count', 'media_type', 'expires_at'];

/** A stateful, mutable in-memory sheet backed by a 2-D array (from prune.test). */
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

/** A spreadsheet with a default first sheet plus named tabs. */
function makeSpreadsheet(firstSheet) {
  const tabs = {};
  return {
    _tabs: tabs,
    getSheets: () => [firstSheet],
    getSheetByName: (name) => tabs[name] || null,
    insertSheet: (name) => { tabs[name] = makeSheet([['vote_id', 'video_id', 'user_email', 'created_at']]); return tabs[name]; },
  };
}

/** CacheService mock with a real backing store; `onPut` can veto a write (oversize). */
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

/** In-memory PropertiesService so the generation actually persists across calls. */
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
 * Loads the backend bound to stateful Videos/Comments spreadsheets, a real
 * CacheService store, and a persistent PropertiesService.
 */
function loadBackend(opts = {}) {
  const videosSheet = makeSheet([VHEADERS, ...(opts.videoRows || [])]);
  const videosSpreadsheet = makeSpreadsheet(videosSheet);
  if (opts.archiveRows) {
    videosSpreadsheet._tabs.Archive = makeSheet([VHEADERS, ...opts.archiveRows]);
  }
  const commentsSpreadsheet = makeSpreadsheet(makeSheet([['comment_id', 'video_id', 'user_name', 'text']]));
  if (opts.voteRows) {
    commentsSpreadsheet._tabs.Votes = makeSheet([['vote_id', 'video_id', 'user_email', 'created_at'], ...opts.voteRows]);
  }
  const meta = makeSpreadsheet(makeSheet([['key', 'value']]));
  const logs = makeSpreadsheet(makeSheet([['ts', 'level', 'source', 'message']]));

  const spreadsheets = {
    VIDEOS_ID: videosSpreadsheet,
    COMMENTS_ID: commentsSpreadsheet,
    META_ID: meta,
    LOGS_ID: logs,
  };

  const cache = opts.cache || makeCache();
  const props = opts.props || makeProps();

  const globals = {
    SpreadsheetApp: { openById: (id) => spreadsheets[id] },
    CacheService: cache,
    PropertiesService: props,
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    Logger: { log() {} },
    Utilities: { sleep() {}, getUuid: () => 'uuid' },
    UrlFetchApp: {},
    ScriptApp: {},
  };

  const patched = SRC
    .replace(/VIDEOS:\s*'[^']+'/, "VIDEOS: 'VIDEOS_ID'")
    .replace(/COMMENTS:\s*'[^']+'/, "COMMENTS: 'COMMENTS_ID'")
    .replace(/META:\s*'[^']+'/, "META: 'META_ID'")
    .replace(/LOGS:\s*'[^']+'/, "LOGS: 'LOGS_ID'");

  const names = [
    'getVideos', 'handleTopWeek', 'handleArchive', 'readSortedArchive',
    'readFeedHead', 'readTopWeek',
    'invalidateFeedHead', 'invalidateTopWeek', 'invalidateArchive',
    'updateVoteCount', 'updateCommentCount',
    'currentCacheGeneration', 'bumpCacheGeneration',
    'readCachedSortedList', 'putCachedSortedList', 'cachedSortedList',
    'FEED_HEAD_CACHE_KEY', 'TOP_WEEK_CACHE_KEY', 'ARCHIVE_CACHE_KEY', 'FEED_HEAD_CACHE_SECONDS',
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

describe('cache generation counter', () => {
  it('defaults to 0 and increments monotonically, persisting to Script Properties', () => {
    const be = loadBackend();
    expect(be.currentCacheGeneration()).toBe(0);
    expect(be.bumpCacheGeneration()).toBe(1);
    expect(be.currentCacheGeneration()).toBe(1);
    be.bumpCacheGeneration();
    expect(be.currentCacheGeneration()).toBe(2);
    // The value is persisted in the shared property store, not a per-call closure.
    expect(be.props._store.CACHE_GENERATION).toBe('2');
  });

  it('every invalidate* bumps the generation', () => {
    const be = loadBackend();
    expect(be.currentCacheGeneration()).toBe(0);
    be.invalidateFeedHead();
    be.invalidateTopWeek();
    be.invalidateArchive();
    expect(be.currentCacheGeneration()).toBe(3);
  });
});

describe('BE2 — repopulation racing invalidation (late put is refused)', () => {
  it('refuses a put stamped with a generation the invalidate has already passed', () => {
    const be = loadBackend({ videoRows: [video('AAAAAAAAAAA', { vote_count: 0 })] });

    // A request populates the head at the current generation.
    be.getVideos(1, 10);
    expect(be.cache._store[be.FEED_HEAD_CACHE_KEY]).toBeTruthy();

    // Request A "started" here — it captured the generation BEFORE reading.
    const genA = be.currentCacheGeneration();

    // A concurrent vote invalidates the head: generation bumps, key dropped.
    be.invalidateFeedHead();
    expect(be.currentCacheGeneration()).toBe(genA + 1);

    // A's read-through populate lands LATE, carrying its stale pre-vote snapshot
    // stamped with genA. It must be refused — not re-installed for the full TTL.
    const stored = be.putCachedSortedList(
      be.FEED_HEAD_CACHE_KEY, be.FEED_HEAD_CACHE_SECONDS,
      { videos: [{ video_id: 'AAAAAAAAAAA', vote_count: 0 }], total: 1 }, genA);

    expect(stored).toBe(false);
    expect(be.cache._store[be.FEED_HEAD_CACHE_KEY]).toBeUndefined();
    expect(be.readFeedHead()).toBeNull();
  });

  it('treats an already-installed stale-stamped payload as a miss on read', () => {
    const be = loadBackend({ videoRows: [video('AAAAAAAAAAA')] });

    // Force a payload stamped with an OLD generation straight into the cache,
    // bypassing the put guard (as if it had been written before a later bump).
    const current = be.currentCacheGeneration();
    be.cache._store[be.FEED_HEAD_CACHE_KEY] = JSON.stringify({
      videos: [{ video_id: 'AAAAAAAAAAA', vote_count: 0 }], total: 1, gen: current - 1,
    });

    // The stamp no longer matches the live generation -> miss, not served stale.
    expect(be.readFeedHead()).toBeNull();
  });

  it('serves a payload put under the CURRENT generation (guard is not always-refuse)', () => {
    const be = loadBackend({ videoRows: [video('AAAAAAAAAAA', { vote_count: 3 })] });
    const gen = be.currentCacheGeneration();
    const ok = be.putCachedSortedList(
      be.FEED_HEAD_CACHE_KEY, be.FEED_HEAD_CACHE_SECONDS,
      { videos: [{ video_id: 'AAAAAAAAAAA', vote_count: 3 }], total: 1 }, gen);
    expect(ok).toBe(true);
    const head = be.readFeedHead();
    expect(head).not.toBeNull();
    expect(head.videos[0].vote_count).toBe(3);
  });
});

describe('BE2 — a vote followed by a feed read reflects the new count (no revert)', () => {
  it('does not resurrect the pre-vote count from cache', () => {
    const be = loadBackend({
      videoRows: [video('AAAAAAAAAAA', { vote_count: 0 })],
      // One vote row exists, so updateVoteCount recounts the video to 1.
      voteRows: [['v1', 'AAAAAAAAAAA', 'u@x', iso(now)]],
    });

    // Warm the head with the pre-vote count.
    const before = be.getVideos(1, 10);
    expect(before.videos[0].vote_count).toBe(0);

    // The vote lands: recount writes vote_count=1 and invalidates the caches.
    expect(be.updateVoteCount('AAAAAAAAAAA')).toBe(1);

    // The next feed read must show the new count — the stale head is gone, and
    // no late put can resurrect it (generation moved on).
    const after = be.getVideos(1, 10);
    expect(after.videos[0].vote_count).toBe(1);
  });

  it('a comment recount likewise survives into the next feed read', () => {
    const be = loadBackend({ videoRows: [video('AAAAAAAAAAA', { comment_count: 0 })] });

    be.getVideos(1, 10); // warm
    const genBefore = be.currentCacheGeneration();
    be.updateCommentCount('AAAAAAAAAAA'); // 0 comments in the sheet -> writes 0, but invalidates
    expect(be.currentCacheGeneration()).toBeGreaterThan(genBefore);
    // Cache dropped: the next read re-derives from the sheet rather than serving stale.
    expect(be.cache._store[be.FEED_HEAD_CACHE_KEY]).toBeUndefined();
  });
});

describe('BE8 (cache half) — archive still serves {videos}, undisabled by an oversize payload', () => {
  const rows = [
    video('ARCHOLDEST1', { at: now - 300 * DAY, title: 'oldest' }),
    video('ARCHNEWEST1', { at: now - 90 * DAY, title: 'newest' }),
    video('ARCHMIDDLE1', { at: now - 200 * DAY, title: 'middle' }),
  ];

  it('serves the archive newest-first and paginates', () => {
    const be = loadBackend({ archiveRows: rows });
    const p1 = be.handleArchive({ page: 1, limit: 2 });
    expect(p1.status).toBe('ok');
    expect(p1.total).toBe(3);
    expect(p1.videos.map((v) => v.video_id)).toEqual(['ARCHNEWEST1', 'ARCHMIDDLE1']);
    const p2 = be.handleArchive({ page: 2, limit: 2 });
    expect(p2.videos.map((v) => v.video_id)).toEqual(['ARCHOLDEST1']);
  });

  it('reads the sheet once across a burst, then re-reads after invalidate bumps the generation', () => {
    const be = loadBackend({ archiveRows: rows });
    const archive = be.videosSpreadsheet._tabs.Archive;

    be.handleArchive({ page: 1, limit: 2 });
    be.handleArchive({ page: 2, limit: 2 });
    expect(archive._stats.reads).toBe(1); // whole burst served from one scan

    be.invalidateArchive();
    be.handleArchive({ page: 1, limit: 2 });
    expect(archive._stats.reads).toBe(2); // generation moved on -> re-scan
  });

  it('still returns the full correct list when the payload is too large to cache', () => {
    // Simulate CacheService rejecting an oversize value (>100KB): every put throws.
    const cache = makeCache(() => { throw new Error('value too large'); });
    const be = loadBackend({ archiveRows: rows, cache });

    // readSortedArchive must fall through to a live scan and still return {videos}.
    const list = be.readSortedArchive();
    expect(list.map((v) => v.video_id)).toEqual(['ARCHNEWEST1', 'ARCHMIDDLE1', 'ARCHOLDEST1']);
    // Nothing got cached (every put failed), but the read is never disabled.
    expect(be.cache._store[be.ARCHIVE_CACHE_KEY]).toBeUndefined();
    const paged = be.handleArchive({ page: 1, limit: 10 });
    expect(paged.total).toBe(3);
    expect(paged.videos).toHaveLength(3);
  });
});
