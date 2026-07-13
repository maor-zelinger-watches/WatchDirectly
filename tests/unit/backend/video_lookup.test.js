/**
 * Unit test for the single-video lookup (backend `video` action).
 *
 * handleVideo backs shared deep links (?v=<id>): it resolves an id against
 * the cached feed head, then the live sheet, then the archive — so a link
 * keeps working after the video ages out of the feed. This pins down each
 * lookup tier, the null-vs-error contract (unknown id is { video: null },
 * missing param is an error), the normalized item shape, and that a warm
 * feed-head cache answers without a sheet scan — against the SHIPPED Code.gs.
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

/** CacheService mock with a real backing store, so read-through works. */
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

/**
 * liveRows / archiveRows: data rows (no header). Archive tab absent when
 * archiveRows is null.
 */
function loadBackend(liveRows, archiveRows = null) {
  const liveSheet = makeSheet([HEADERS, ...liveRows]);
  const named = {};
  if (archiveRows !== null) {
    named.Archive = makeSheet([HEADERS, ...archiveRows]);
  }
  const videosSpreadsheet = makeSpreadsheet(liveSheet, named);
  const cache = makeCache();

  const globals = {
    SpreadsheetApp: { openById: () => videosSpreadsheet },
    CacheService: cache,
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Logger: { log() {} },
    Utilities: {}, UrlFetchApp: {}, ScriptApp: {},
  };

  const patched = SRC.replace(/VIDEOS:\s*'[^']+'/, "VIDEOS: 'VIDEOS_ID'");
  const names = ['handleVideo', 'getVideos'];
  const factory = new Function(...Object.keys(globals), `${patched}\nreturn { ${names.join(', ')} };`);
  return { ...factory(...Object.values(globals)), cache, liveSheet };
}

describe('handleVideo', () => {
  const now = Date.now();
  const ARTICLE_ID = 'aGVsbG8td29ybGQtYXJ0aWNsZQ=='; // base64-ish, > 11 chars
  const liveRows = [
    ['LIVEVIDEO01', 'Chan A', 'a live video', 'https://x/1', iso(now - 1 * DAY), '3', '7', 'video', ''],
    [ARTICLE_ID, 'Blog B', 'an article', 'https://x/2', iso(now - 2 * DAY), '', '', '', ''],
  ];
  const archiveRows = [
    ['ARCHVIDEO01', 'Chan C', 'an archived video', 'https://x/3', iso(now - 300 * DAY), 0, 0, 'video', ''],
  ];

  it('finds a video in the live sheet, in the normalized feed-item shape', () => {
    const be = loadBackend(liveRows, archiveRows);
    const res = be.handleVideo({ videoId: 'LIVEVIDEO01' });
    expect(res.status).toBe('ok');
    expect(res.video).toMatchObject({
      video_id: 'LIVEVIDEO01',
      title: 'a live video',
      channel_name: 'Chan A',
      media_type: 'video',
      vote_count: 7, // coerced to integer by the shared normalizer
    });
  });

  it('infers media_type for a legacy article row (long id, blank column)', () => {
    const be = loadBackend(liveRows);
    const res = be.handleVideo({ videoId: ARTICLE_ID });
    expect(res.video).toMatchObject({ video_id: ARTICLE_ID, media_type: 'article' });
  });

  it('falls through to the archive when the video aged out of the live sheet', () => {
    const be = loadBackend(liveRows, archiveRows);
    const res = be.handleVideo({ videoId: 'ARCHVIDEO01' });
    expect(res.status).toBe('ok');
    expect(res.video).toMatchObject({ video_id: 'ARCHVIDEO01', title: 'an archived video' });
  });

  it('returns { video: null } — not an error — for an unknown id', () => {
    const be = loadBackend(liveRows, archiveRows);
    const res = be.handleVideo({ videoId: 'NOSUCHVID01' });
    expect(res).toEqual({ status: 'ok', video: null });
  });

  it('returns { video: null } for an unknown id when there is no archive tab', () => {
    const be = loadBackend(liveRows, null);
    const res = be.handleVideo({ videoId: 'NOSUCHVID01' });
    expect(res).toEqual({ status: 'ok', video: null });
  });

  it('rejects a missing/blank videoId with the error shape', () => {
    const be = loadBackend(liveRows);
    expect(be.handleVideo({}).status).toBe('error');
    expect(be.handleVideo({ videoId: '   ' }).status).toBe('error');
    expect(be.handleVideo(undefined).status).toBe('error');
  });

  it('answers from a warm feed-head cache without scanning the live sheet', () => {
    const be = loadBackend(liveRows, archiveRows);
    // A feed request populates the head cache (read-through).
    be.getVideos(1, 20, '');
    const scansAfterFeed = be.liveSheet._stats.reads;

    const res = be.handleVideo({ videoId: 'LIVEVIDEO01' });
    expect(res.video.video_id).toBe('LIVEVIDEO01');
    expect(be.liveSheet._stats.reads).toBe(scansAfterFeed); // no extra scan
  });
});

describe('getVideos input clamping (B2)', () => {
  const now = Date.now();
  const liveRows = [
    ['LIVEVIDEO01', 'Chan A', 'newest', 'https://x/1', iso(now - 1 * DAY), '0', '0', 'video', ''],
    ['LIVEVIDEO02', 'Chan A', 'older', 'https://x/2', iso(now - 2 * DAY), '0', '0', 'video', ''],
  ];

  it('clamps a negative page/limit to a sane first-page window (no slice(-40,-20) nonsense)', () => {
    const be = loadBackend(liveRows);
    const res = be.getVideos(-1, -5, '');
    expect(res.status).toBe('ok');
    expect(res.total).toBe(2);
    // page/limit clamp to 1 -> the single newest video, never a negative-index
    // slice reading from the END of the list.
    expect(res.videos).toHaveLength(1);
    expect(res.videos[0].video_id).toBe('LIVEVIDEO01');
    expect(res.videos.length).toBeLessThanOrEqual(res.total);
  });

  it('clamps a zero limit rather than returning an empty/garbage window', () => {
    const be = loadBackend(liveRows);
    const res = be.getVideos(0, 0, '');
    expect(res.status).toBe('ok');
    expect(res.videos).toHaveLength(1);
    expect(res.videos[0].video_id).toBe('LIVEVIDEO01');
  });
});
