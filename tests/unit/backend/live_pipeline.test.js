/**
 * End-to-end pipeline test for the premiere/live feature (backend 1.1.0).
 *
 * This feature is entirely backend (Apps Script over Sheets) — the frontend
 * doesn't render live_status — so a Playwright browser e2e would have nothing
 * to assert. The real "end to end" is the crawl path exercised here against the
 * SHIPPED Code.gs: a mocked RSS feed + a mocked YouTube videos.list flow all the
 * way through crawlAllFeeds into a stateful in-memory Sheet, then out through
 * readAllVideos (the actual served-feed reader).
 *
 * Scenario: an "upcoming" premiere is crawled -> lands with an expires_at and is
 * withheld from the feed -> the broadcast airs -> a second crawl re-enriches the
 * SAME video id to 'none', clears expires_at in place, and the permanent VOD now
 * appears. XmlService is left undefined so parseRssFeed falls back to its regex
 * parser (no Java XML runtime needed in Node).
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
      setValues() {},
      setNumberFormat() {},
    }),
    appendRow: (r) => { grid.push(r.slice()); },
    getLastRow: () => grid.length,
  };
}

const VIDEO_HEADERS = ['video_id', 'channel_name', 'title', 'url', 'published_at', 'fetched_at', 'tier', 'category', 'comment_count', 'vote_count', 'media_type', 'preview_image', 'view_count'];

const CHANNEL_ROWS = [
  ['channel_name', 'feed_url', 'tier', 'category', 'enabled'],
  ['Watch Channel', 'https://feed.example/rss', 0, 'Heavyweights', true],
];

const VIDEO_ID = 'PREMIERE001'; // 11 chars -> treated as a YouTube video

/** RSS 2.0 feed with one YouTube watch item; parsed via the regex fallback. */
function rssFeed() {
  return `<?xml version="1.0"?><rss version="2.0"><channel>
    <item><title>Big Premiere</title>
    <link>https://www.youtube.com/watch?v=${VIDEO_ID}</link>
    <pubDate>Mon, 07 Jul 2026 10:00:00 GMT</pubDate></item>
  </channel></rss>`;
}

/**
 * Build the mock globals and return the shipped crawl + read functions, sharing
 * one stateful VIDEOS/META/CHANNELS set of sheets. `broadcast` maps video id ->
 * { status, scheduled } for the mocked videos.list response.
 */
function loadPipeline(broadcast) {
  const sheets = {
    CHANNELS_ID: makeSheet(CHANNEL_ROWS),
    VIDEOS_ID: makeSheet([VIDEO_HEADERS]),
    META_ID: makeSheet([['key', 'value'], ['youtube_api_key', 'test-key']]),
  };
  const state = { broadcast };

  const fetch = (url) => {
    if (url.indexOf('feed.example') !== -1) {
      return { getResponseCode: () => 200, getContentText: () => rssFeed() };
    }
    if (url.indexOf('googleapis.com/youtube') !== -1) {
      const idMatch = url.match(/[?&]id=([^&]+)/);
      const ids = idMatch ? idMatch[1].split(',') : [];
      const items = ids.filter((id) => state.broadcast[id]).map((id) => ({
        id,
        snippet: { liveBroadcastContent: state.broadcast[id].status },
        liveStreamingDetails: state.broadcast[id].scheduled ? { scheduledStartTime: state.broadcast[id].scheduled } : {},
      }));
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ items }) };
    }
    return { getResponseCode: () => 404, getContentText: () => '' };
  };

  const globals = {
    UrlFetchApp: { fetch },
    SpreadsheetApp: {
      openById: (id) => ({ getSheets: () => [sheets[id]] }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: () => '0', computeDigest: () => [], base64EncodeWebSafe: () => 'x', sleep() {},
      DigestAlgorithm: { MD5: 'MD5' },
    },
    Logger: { log() {} },
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
    ScriptApp: {},
    XmlService: undefined, // force parseRegex fallback
  };
  // Point getSheet() at our sentinel ids.
  const patched = SRC
    .replace(/CHANNELS:\s*'[^']+'/, "CHANNELS: 'CHANNELS_ID'")
    .replace(/VIDEOS:\s*'[^']+'/, "VIDEOS: 'VIDEOS_ID'")
    .replace(/META:\s*'[^']+'/, "META: 'META_ID'");

  const names = ['crawlAllFeeds', 'readAllVideos'];
  const factory = new Function(...Object.keys(globals), `${patched}\nreturn { ${names.join(', ')} };`);
  return { ...factory(...Object.values(globals)), sheets, state };
}

describe('crawl -> enrich -> read pipeline', () => {
  it('surfaces a fresh premiere, then turns the SAME id permanent once it airs', () => {
    const scheduled = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2h out
    const be = loadPipeline({ [VIDEO_ID]: { status: 'upcoming', scheduled } });

    // --- First crawl: premiere is still upcoming ---
    const first = be.crawlAllFeeds();
    expect(first.new_videos).toBe(1);

    // The row was written with live metadata + a future expiry.
    const grid = be.sheets.VIDEOS_ID._grid;
    const headers = grid[0];
    const stored = grid[1];
    const col = (name) => headers.indexOf(name);
    expect(stored[col('video_id')]).toBe(VIDEO_ID);
    expect(stored[col('live_status')]).toBe('upcoming');
    expect(stored[col('scheduled_start')]).toBe(scheduled);
    expect(stored[col('expires_at')]).toBeTruthy();

    // While fresh (expiry in the future) the premiere IS served — readAllVideos
    // only drops entries whose expires_at has already passed.
    expect(be.readAllVideos().map((v) => v.video_id)).toContain(VIDEO_ID);

    // --- Broadcast airs: same id now reports 'none' ---
    be.state.broadcast[VIDEO_ID] = { status: 'none', scheduled: '' };
    const second = be.crawlAllFeeds();
    expect(second.new_videos).toBe(0); // no new row — updated in place

    // Same single row, now permanent: status flipped, expiry cleared.
    expect(be.sheets.VIDEOS_ID._grid).toHaveLength(2); // header + one row
    const updated = be.sheets.VIDEOS_ID._grid[1];
    expect(updated[col('live_status')]).toBe('none');
    expect(updated[col('expires_at')]).toBe('');

    const feed = be.readAllVideos();
    expect(feed).toHaveLength(1);
    expect(feed[0].video_id).toBe(VIDEO_ID);
  });

  it('expires a premiere that never airs out of the served feed', () => {
    // Scheduled far in the past -> expires_at = start + 12h grace is already past.
    const scheduled = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const be = loadPipeline({ [VIDEO_ID]: { status: 'upcoming', scheduled } });

    be.crawlAllFeeds();
    // Row exists in the sheet...
    expect(be.sheets.VIDEOS_ID._grid).toHaveLength(2);
    // ...but the served feed drops it because expires_at is in the past.
    expect(be.readAllVideos()).toHaveLength(0);
  });
});
