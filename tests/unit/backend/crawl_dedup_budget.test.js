/**
 * Crawl-time URL dedup (B4) and the wall-clock budget / resume index (B8),
 * exercised against the SHIPPED Code.gs crawlAllFeeds via a stateful in-memory
 * Sheet. XmlService is left undefined so parseRssFeed uses its regex fallback
 * (no Java XML runtime in Node).
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

// Full schema incl. the live trio, so the crawl never has to self-add columns.
const VIDEO_HEADERS = ['video_id', 'channel_name', 'title', 'url', 'published_at', 'fetched_at', 'tier', 'category', 'comment_count', 'vote_count', 'media_type', 'preview_image', 'view_count', 'live_status', 'scheduled_start', 'expires_at'];

function metaValue(metaSheet, key) {
  const row = metaSheet._grid.find((r) => r[0] === key);
  return row ? row[1] : undefined;
}

/**
 * @param opts.channels  array of [name, feedUrl]
 * @param opts.feeds     map feedUrl -> RSS xml string
 * @param opts.broadcast map youtubeId -> { status, scheduled }
 * @param opts.videoRows pre-seeded rows for the Videos sheet (no header)
 * @param opts.DateImpl  optional Date override (for the budget clock)
 * @param opts.meta      pre-seeded META rows (besides header + api key)
 */
function loadCrawl(opts) {
  const channelRows = [['channel_name', 'feed_url', 'tier', 'category', 'enabled']]
    .concat(opts.channels.map((c) => [c[0], c[1], 0, 'Heavyweights', true]));
  const videosSheet = makeSheet([VIDEO_HEADERS, ...(opts.videoRows || [])]);
  const metaSheet = makeSheet([['key', 'value'], ['youtube_api_key', 'test-key'], ...(opts.meta || [])]);
  const sheets = {
    CHANNELS_ID: makeSheet(channelRows),
    VIDEOS_ID: videosSheet,
    META_ID: metaSheet,
  };

  const fetch = (url) => {
    if (opts.feeds[url]) {
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

  const globals = {
    UrlFetchApp: { fetch },
    SpreadsheetApp: { openById: (id) => ({ getSheets: () => [sheets[id]], getSheetByName: () => null }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: () => '0', computeDigest: () => [1, 2, 3], base64EncodeWebSafe: () => 'HASHEDID0000000',
      sleep() {}, DigestAlgorithm: { MD5: 'MD5' },
    },
    Logger: { log() {} },
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
    ScriptApp: {},
    XmlService: undefined, // force parseRegex fallback
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  };
  if (opts.DateImpl) globals.Date = opts.DateImpl;

  const patched = SRC
    .replace(/CHANNELS:\s*'[^']+'/, "CHANNELS: 'CHANNELS_ID'")
    .replace(/VIDEOS:\s*'[^']+'/, "VIDEOS: 'VIDEOS_ID'")
    .replace(/META:\s*'[^']+'/, "META: 'META_ID'");

  const names = ['crawlAllFeeds'];
  const factory = new Function(...Object.keys(globals), `${patched}\nreturn { ${names.join(', ')} };`);
  return { ...factory(...Object.values(globals)), sheets, videosSheet, metaSheet };
}

function rssArticle(link, title) {
  return `<?xml version="1.0"?><rss version="2.0"><channel>
    <item><title>${title}</title><link>${link}</link>
    <pubDate>Mon, 07 Jul 2026 10:00:00 GMT</pubDate></item>
  </channel></rss>`;
}

function rssVideo(youtubeId) {
  return rssArticle('https://www.youtube.com/watch?v=' + youtubeId, 'Vid ' + youtubeId);
}

describe('crawl-time URL dedup (B4)', () => {
  it('skips a new item whose URL already exists even when its id differs', () => {
    const ARTICLE_URL = 'https://blog.example/post-1';
    // A row already exists for this URL under an OLD id (as if a prior crawl
    // hashed guid||link); the regex-path crawl now derives a DIFFERENT id
    // (hashed from link) for the same URL. Id-keyed dedup alone would append a
    // duplicate; URL-keyed dedup must skip it.
    const preexisting = ['OLDARTICLEID', 'Blog', 'old title', ARTICLE_URL, '2026-07-01', '2026-07-01', 0, 'Heavyweights', 0, 0, 'article', '', 0, 'none', '', ''];

    const be = loadCrawl({
      channels: [['Blog', 'https://feed.example/blog']],
      feeds: { 'https://feed.example/blog': rssArticle(ARTICLE_URL, 'new title from feed') },
      videoRows: [preexisting],
    });

    const res = be.crawlAllFeeds();
    expect(res.new_videos).toBe(0); // URL already present -> not appended
    // Header + the single pre-existing row, no duplicate.
    expect(be.videosSheet._grid).toHaveLength(2);
    expect(be.videosSheet._grid[1][0]).toBe('OLDARTICLEID');
  });

  it('still appends a genuinely new URL', () => {
    const be = loadCrawl({
      channels: [['Blog', 'https://feed.example/blog']],
      feeds: { 'https://feed.example/blog': rssArticle('https://blog.example/brand-new', 'fresh') },
      videoRows: [],
    });
    const res = be.crawlAllFeeds();
    expect(res.new_videos).toBe(1);
    expect(be.videosSheet._grid).toHaveLength(2);
  });
});

describe('crawl wall-clock budget + resume index (B8)', () => {
  // Round-trips the resume index through Meta and proves a normal full crawl
  // resets it to 0 (so it can't drift).
  it('resets the resume index to 0 after a normal under-budget crawl', () => {
    const be = loadCrawl({
      channels: [['C1', 'https://feed.example/1'], ['C2', 'https://feed.example/2']],
      feeds: {
        'https://feed.example/1': rssVideo('AAAAAAAAAAA'),
        'https://feed.example/2': rssVideo('BBBBBBBBBBB'),
      },
      broadcast: { AAAAAAAAAAA: { status: 'none' }, BBBBBBBBBBB: { status: 'none' } },
      meta: [['crawl_resume_index', '1']], // stale index from a prior run
    });
    const res = be.crawlAllFeeds();
    expect(res.new_videos).toBe(2); // full pass ingests both
    expect(res.stopped_early).toBe(false);
    expect(metaValue(be.metaSheet, 'crawl_resume_index')).toBe('0');
  });

  it('stops at the budget and records the next channel to resume from', () => {
    // Controllable clock: no-arg new Date().getTime() returns 1000 on the FIRST
    // call (crawlStartMs) and a value well past the budget thereafter, so the
    // per-channel budget check trips before the 2nd channel. Arg-form Date and
    // Date.now() delegate to the real Date so dates/prune behave normally.
    const RealDate = Date;
    let firstCall = true;
    function MockDate(...args) {
      if (args.length === 0) {
        const d = new RealDate();
        d.getTime = () => {
          if (firstCall) { firstCall = false; return 1000; }
          return 1000 + 999999; // elapsed >> CRAWL_BUDGET_MS (270000)
        };
        return d;
      }
      return new RealDate(...args);
    }
    MockDate.now = () => RealDate.now();

    const be = loadCrawl({
      channels: [
        ['C1', 'https://feed.example/1'],
        ['C2', 'https://feed.example/2'],
        ['C3', 'https://feed.example/3'],
      ],
      feeds: {
        'https://feed.example/1': rssVideo('AAAAAAAAAAA'),
        'https://feed.example/2': rssVideo('BBBBBBBBBBB'),
        'https://feed.example/3': rssVideo('CCCCCCCCCCC'),
      },
      broadcast: {
        AAAAAAAAAAA: { status: 'none' }, BBBBBBBBBBB: { status: 'none' }, CCCCCCCCCCC: { status: 'none' },
      },
      DateImpl: MockDate,
    });

    const res = be.crawlAllFeeds();
    expect(res.stopped_early).toBe(true);
    expect(res.new_videos).toBe(1); // only the first channel ran
    // Next crawl resumes at channel index 1 (the first one we didn't reach).
    expect(metaValue(be.metaSheet, 'crawl_resume_index')).toBe('1');
    // Header + exactly one ingested row.
    expect(be.videosSheet._grid).toHaveLength(2);
    expect(be.videosSheet._grid[1][0]).toBe('AAAAAAAAAAA');
  });

  it('resumes from the recorded index, wraps around, and finishes the tail', () => {
    // Seed resume index = 2 (as if a prior crawl stopped there). A full,
    // under-budget pass should process channels 2, 0, 1 (wrapping) and reset to 0.
    const be = loadCrawl({
      channels: [
        ['C1', 'https://feed.example/1'],
        ['C2', 'https://feed.example/2'],
        ['C3', 'https://feed.example/3'],
      ],
      feeds: {
        'https://feed.example/1': rssVideo('AAAAAAAAAAA'),
        'https://feed.example/2': rssVideo('BBBBBBBBBBB'),
        'https://feed.example/3': rssVideo('CCCCCCCCCCC'),
      },
      broadcast: {
        AAAAAAAAAAA: { status: 'none' }, BBBBBBBBBBB: { status: 'none' }, CCCCCCCCCCC: { status: 'none' },
      },
      meta: [['crawl_resume_index', '2']],
    });
    const res = be.crawlAllFeeds();
    expect(res.stopped_early).toBe(false);
    expect(res.new_videos).toBe(3); // all three ingested regardless of start offset
    expect(metaValue(be.metaSheet, 'crawl_resume_index')).toBe('0');
    const ids = be.videosSheet._grid.slice(1).map((r) => r[0]).sort();
    expect(ids).toEqual(['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC']);
  });
});
