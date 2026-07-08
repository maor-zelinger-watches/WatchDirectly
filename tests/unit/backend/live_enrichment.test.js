/**
 * Unit tests for the premiere/live enrichment added to apps-script/Code.gs
 * (backend 1.1.0). As with handlers.test.js, the REAL Code.gs source is eval'd
 * with injected mock globals and the shipped functions are exercised directly —
 * no reimplemented copies.
 *
 * Covered:
 *   - enrichLiveMetadata: upcoming/live/none mapping, expires_at math, batching,
 *     graceful no-op when unconfigured or on API error, article skipping.
 *   - readAllVideos: expired provisional entries are filtered out of the feed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');
const LIVE_GRACE_MS = 12 * 60 * 60 * 1000; // must match the constant in Code.gs

/** A sheet whose getValues() returns `rows`; getRange is a harmless no-op. */
function sheetWithRows(rows) {
  return {
    getDataRange: () => ({ getValues: () => rows }),
    getRange: () => ({ setValue() {}, setValues() {}, setNumberFormat() {} }),
    appendRow: () => {},
    getLastRow: () => rows.length,
  };
}

/**
 * Eval Code.gs with mock globals and return the named functions.
 * `metaRows` backs getMeta (a [key, value] table); `fetch` backs UrlFetchApp.
 */
function loadBackend({ metaRows = [['key', 'value']], videoRows = null, fetch } = {}) {
  const metaSheet = sheetWithRows(metaRows);
  const videoSheet = videoRows ? sheetWithRows(videoRows) : metaSheet;
  const globals = {
    UrlFetchApp: { fetch: fetch || (() => ({ getResponseCode: () => 200, getContentText: () => '{"items":[]}' })) },
    SpreadsheetApp: {
      // getSheet(key) opens SPREADSHEET_IDS[key]; META and VIDEOS have distinct ids.
      openById: (id) => ({ getSheets: () => [id === 'VIDEOS_ID' ? videoSheet : metaSheet] }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: () => '0', computeDigest: () => [], base64EncodeWebSafe: () => 'x', sleep() {},
      DigestAlgorithm: { MD5: 'MD5' },
    },
    Logger: { log() {} },
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
    ScriptApp: {}, XmlService: {},
  };
  // Rewrite the real spreadsheet ids to the sentinels our openById switches on.
  const patched = SRC
    .replace(/VIDEOS:\s*'[^']+'/, "VIDEOS: 'VIDEOS_ID'");
  const names = ['enrichLiveMetadata', 'readAllVideos'];
  const factory = new Function(...Object.keys(globals), `${patched}\nreturn { ${names.join(', ')} };`);
  return factory(...Object.values(globals));
}

/**
 * A UrlFetchApp.fetch mock for videos.list. `byId` maps video id ->
 * { status, scheduled, views? }. Records every requested URL in `calls`.
 */
function youtubeFetch(byId, calls, code = 200) {
  return (url) => {
    calls.push(url);
    const idMatch = url.match(/[?&]id=([^&]+)/);
    const ids = idMatch ? idMatch[1].split(',') : [];
    const items = ids
      .filter((id) => byId[id])
      .map((id) => {
        const item = {
          id,
          snippet: { liveBroadcastContent: byId[id].status },
          liveStreamingDetails: byId[id].scheduled ? { scheduledStartTime: byId[id].scheduled } : {},
        };
        // Mirror the API: statistics.viewCount is a decimal string, and the
        // whole statistics block is absent when a video hides its counts.
        if (byId[id].views !== undefined) item.statistics = { viewCount: String(byId[id].views) };
        return item;
      });
    return { getResponseCode: () => code, getContentText: () => JSON.stringify({ items }) };
  };
}

const withKey = [['key', 'value'], ['youtube_api_key', 'test-key']];

describe('enrichLiveMetadata', () => {
  it('marks an upcoming premiere with status, scheduled_start and expires_at = start + grace', () => {
    const start = '2026-08-01T18:00:00.000Z';
    const calls = [];
    const { enrichLiveMetadata } = loadBackend({
      metaRows: withKey,
      fetch: youtubeFetch({ vid00000001: { status: 'upcoming', scheduled: start } }, calls),
    });
    const videos = [{ video_id: 'vid00000001', media_type: 'video' }];
    enrichLiveMetadata(videos);

    expect(videos[0].live_status).toBe('upcoming');
    expect(videos[0].scheduled_start).toBe(start);
    expect(videos[0].expires_at).toBe(new Date(new Date(start).getTime() + LIVE_GRACE_MS).toISOString());
    expect(calls).toHaveLength(1);
  });

  it('marks a live stream (no scheduled start) as live with an expiry anchored to now', () => {
    const before = Date.now();
    const { enrichLiveMetadata } = loadBackend({
      metaRows: withKey,
      fetch: youtubeFetch({ vid00000002: { status: 'live', scheduled: '' } }, []),
    });
    const videos = [{ video_id: 'vid00000002', media_type: 'video' }];
    enrichLiveMetadata(videos);
    const after = Date.now();

    expect(videos[0].live_status).toBe('live');
    expect(videos[0].scheduled_start).toBe('');
    const exp = new Date(videos[0].expires_at).getTime();
    expect(exp).toBeGreaterThanOrEqual(before + LIVE_GRACE_MS);
    expect(exp).toBeLessThanOrEqual(after + LIVE_GRACE_MS);
  });

  it('leaves a finished/normal upload (none) permanent — no expires_at', () => {
    const { enrichLiveMetadata } = loadBackend({
      metaRows: withKey,
      fetch: youtubeFetch({ vid00000003: { status: 'none', scheduled: '' } }, []),
    });
    const videos = [{ video_id: 'vid00000003', media_type: 'video' }];
    enrichLiveMetadata(videos);

    expect(videos[0].live_status).toBe('none');
    expect(videos[0].expires_at).toBe('');
  });

  it('is a no-op when no youtube_api_key is configured (never calls the API)', () => {
    const calls = [];
    const { enrichLiveMetadata } = loadBackend({
      metaRows: [['key', 'value']], // no youtube_api_key
      fetch: youtubeFetch({ vid00000004: { status: 'upcoming', scheduled: '2026-08-01T00:00:00Z' } }, calls),
    });
    const videos = [{ video_id: 'vid00000004', media_type: 'video' }];
    enrichLiveMetadata(videos);

    expect(videos[0].live_status).toBeUndefined();
    expect(videos[0].expires_at).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('degrades to plain behaviour on an API error (non-200) — leaves fields unset', () => {
    const { enrichLiveMetadata } = loadBackend({
      metaRows: withKey,
      fetch: youtubeFetch({ vid00000005: { status: 'live', scheduled: '' } }, [], 403),
    });
    const videos = [{ video_id: 'vid00000005', media_type: 'video' }];
    enrichLiveMetadata(videos);

    expect(videos[0].live_status).toBeUndefined();
    expect(videos[0].expires_at).toBeUndefined();
  });

  it('only enriches 11-char youtube videos — articles are skipped', () => {
    const calls = [];
    const { enrichLiveMetadata } = loadBackend({
      metaRows: withKey,
      fetch: youtubeFetch({ vid00000006: { status: 'upcoming', scheduled: '2026-08-01T00:00:00Z' } }, calls),
    });
    const videos = [
      { video_id: 'vid00000006', media_type: 'video' },
      { video_id: 'someLongArticleHashId', media_type: 'article' },
    ];
    enrichLiveMetadata(videos);

    expect(videos[0].live_status).toBe('upcoming');
    expect(videos[1].live_status).toBeUndefined();
    // The article id must not appear in any request.
    expect(calls.join('')).not.toContain('someLongArticleHashId');
  });

  it('batches more than 50 ids into separate videos.list calls', () => {
    const byId = {};
    const videos = [];
    for (let i = 0; i < 51; i++) {
      const id = 'v' + String(i).padStart(10, '0'); // 11 distinct chars
      byId[id] = { status: 'none', scheduled: '' };
      videos.push({ video_id: id, media_type: 'video' });
    }
    const calls = [];
    const { enrichLiveMetadata } = loadBackend({ metaRows: withKey, fetch: youtubeFetch(byId, calls) });
    enrichLiveMetadata(videos);
    expect(calls).toHaveLength(2); // 50 + 1
  });
});

describe('enrichLiveMetadata — view counts', () => {
  it('writes the live view count from statistics.viewCount as a number', () => {
    const { enrichLiveMetadata } = loadBackend({
      metaRows: withKey,
      fetch: youtubeFetch({ vid00000020: { status: 'none', scheduled: '', views: 12345 } }, []),
    });
    const videos = [{ video_id: 'vid00000020', media_type: 'video', view_count: 0 }];
    enrichLiveMetadata(videos);
    expect(videos[0].view_count).toBe(12345);
  });

  it('refreshes both live state and view count from the one batched call', () => {
    const calls = [];
    const start = '2026-08-01T18:00:00.000Z';
    const { enrichLiveMetadata } = loadBackend({
      metaRows: withKey,
      fetch: youtubeFetch({ vid00000021: { status: 'upcoming', scheduled: start, views: 42 } }, calls),
    });
    const videos = [{ video_id: 'vid00000021', media_type: 'video', view_count: 0 }];
    enrichLiveMetadata(videos);
    expect(videos[0].live_status).toBe('upcoming');
    expect(videos[0].view_count).toBe(42);
    expect(calls).toHaveLength(1); // one videos.list call serves both
  });

  it('leaves the ingested count intact when the item hides its stats', () => {
    const { enrichLiveMetadata } = loadBackend({
      metaRows: withKey,
      fetch: youtubeFetch({ vid00000022: { status: 'none', scheduled: '' } }, []), // no views
    });
    const videos = [{ video_id: 'vid00000022', media_type: 'video', view_count: 999 }];
    enrichLiveMetadata(videos);
    expect(videos[0].view_count).toBe(999);
  });

  it('does not touch view_count on an API error', () => {
    const { enrichLiveMetadata } = loadBackend({
      metaRows: withKey,
      fetch: youtubeFetch({ vid00000023: { status: 'none', scheduled: '', views: 5000 } }, [], 403),
    });
    const videos = [{ video_id: 'vid00000023', media_type: 'video', view_count: 10 }];
    enrichLiveMetadata(videos);
    expect(videos[0].view_count).toBe(10);
  });
});

describe('readAllVideos — expiry filtering', () => {
  const HEADERS = ['video_id', 'channel_name', 'title', 'url', 'published_at', 'media_type', 'vote_count', 'comment_count', 'live_status', 'scheduled_start', 'expires_at'];
  const row = (id, url, expires) => [id, 'Ch', 'T', url, '2026-07-01T00:00:00Z', 'video', 0, 0, expires ? 'upcoming' : 'none', '', expires];

  it('hides a provisional entry whose expires_at is in the past', () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const rows = [HEADERS, row('vid00000010', 'https://youtu.be/a', past)];
    const { readAllVideos } = loadBackend({ videoRows: rows });
    expect(readAllVideos()).toHaveLength(0);
  });

  it('keeps a provisional entry whose expires_at is still in the future', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const rows = [HEADERS, row('vid00000011', 'https://youtu.be/b', future)];
    const { readAllVideos } = loadBackend({ videoRows: rows });
    expect(readAllVideos()).toHaveLength(1);
  });

  it('keeps permanent entries (blank expires_at)', () => {
    const rows = [HEADERS, row('vid00000012', 'https://youtu.be/c', '')];
    const { readAllVideos } = loadBackend({ videoRows: rows });
    const out = readAllVideos();
    expect(out).toHaveLength(1);
    expect(out[0].video_id).toBe('vid00000012');
  });

  it('filters only the expired rows in a mixed set', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const rows = [
      HEADERS,
      row('vid00000013', 'https://youtu.be/d', past),   // dropped
      row('vid00000014', 'https://youtu.be/e', future),  // kept
      row('vid00000015', 'https://youtu.be/f', ''),      // kept
    ];
    const { readAllVideos } = loadBackend({ videoRows: rows });
    const ids = readAllVideos().map((v) => v.video_id).sort();
    expect(ids).toEqual(['vid00000014', 'vid00000015']);
  });
});
