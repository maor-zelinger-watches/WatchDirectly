/**
 * Shorts classification across the two YouTube ingest paths, exercised against
 * the SHIPPED Code.gs crawlAllFeeds via a stateful in-memory Sheet.
 *
 * The frontend files an item as a Short purely by a /shorts/ URL. The RSS feed
 * supplies that URL; the Data-API fallback (used when YouTube blocks RSS from
 * Apps Script IPs) cannot, so:
 *   1. genuinely new Data-API items are probed (youtube.com/shorts/<id>: 200 =
 *      Short, 303 → /watch = not) before the row is written, and
 *   2. a row that was stored with a watch URL is upgraded in place the next
 *      time the RSS feed says /shorts/ for the same id (self-heal).
 *
 * XmlService is left undefined so parseRssFeed uses its regex fallback.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');

function makeSheet(rows) {
  const grid = rows.map((r) => r.slice());
  return {
    _grid: grid,
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getRange: (row, col, numRows, numCols) => ({
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

const VIDEO_HEADERS = ['video_id', 'channel_name', 'title', 'url', 'published_at', 'fetched_at', 'tier', 'category', 'comment_count', 'vote_count', 'media_type', 'preview_image', 'view_count', 'live_status', 'scheduled_start', 'expires_at'];
const URL_COL = VIDEO_HEADERS.indexOf('url');

const CHANNEL_ID = 'UCpn6IctAyZPk1QoHUAAJUnQ';
const YT_FEED = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + CHANNEL_ID;
const watch = (id) => 'https://www.youtube.com/watch?v=' + id;
const shorts = (id) => 'https://www.youtube.com/shorts/' + id;

function row(id, url) {
  return [id, 'The 1916 Company', 'Vid ' + id, url, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 0, 'Heavyweights', 0, 0, 'video', '', 0, 'none', '', ''];
}

/** RSS2 whose <link>s are whatever the test passes — /shorts/ or /watch. */
function rss(links) {
  return '<?xml version="1.0"?><rss version="2.0"><channel>' + links.map((l, i) =>
    `<item><title>Item ${i}</title><link>${l}</link><pubDate>Thu, 02 Oct 2026 04:00:00 GMT</pubDate></item>`,
  ).join('') + '</channel></rss>';
}

function playlistJson(ids) {
  return JSON.stringify({
    items: ids.map((id) => ({
      snippet: { title: 'Vid ' + id, publishedAt: '2026-10-02T04:00:00Z', thumbnails: {} },
      contentDetails: { videoId: id, videoPublishedAt: '2026-10-02T04:00:00Z' },
    })),
  });
}

/**
 * @param opts.rss       RSS body for the channel feed, or an HTTP status number to fail it
 * @param opts.playlist  ids the Data-API playlist returns (fallback path)
 * @param opts.probe     map id -> 'short' | 'long' | 'missing' | 'error' | 'loop'
 * @param opts.videoRows pre-seeded Videos rows
 */
function loadCrawl(opts) {
  const videosSheet = makeSheet([VIDEO_HEADERS, ...(opts.videoRows || [])]);
  const metaSheet = makeSheet([['key', 'value'], ['youtube_api_key', 'test-key'], ['log_level', 'ERROR']]);
  const sheets = {
    CHANNELS_ID: makeSheet([['channel_name', 'feed_url', 'tier', 'category', 'enabled'], ['The 1916 Company', YT_FEED, 0, 'Heavyweights', true]]),
    VIDEOS_ID: videosSheet,
    META_ID: metaSheet,
  };
  const probed = [];
  const resp = (code, text, headers) => ({ getResponseCode: () => code, getContentText: () => text || '', getAllHeaders: () => headers || {} });

  const fetch = (url) => {
    if (url === YT_FEED) {
      return typeof opts.rss === 'number' ? resp(opts.rss, 'blocked') : resp(200, opts.rss);
    }
    if (url.includes('googleapis.com/youtube/v3/playlistItems')) {
      return resp(200, playlistJson(opts.playlist || []));
    }
    if (url.includes('googleapis.com/youtube/v3/videos')) {
      return resp(200, '{"items":[]}'); // enrichLiveMetadata: nothing to add
    }
    const m = url.match(/youtube\.com\/shorts\/([\w-]{11})/);
    if (m) {
      probed.push(m[1]);
      const kind = (opts.probe || {})[m[1]];
      if (kind === 'short') return resp(200, '<html>');
      if (kind === 'long') return resp(303, '', { Location: watch(m[1]) });
      if (kind === 'missing') return resp(404, '');
      if (kind === 'loop') return resp(302, '', { Location: 'https://m.youtube.com/shorts/' + m[1] });
      if (kind === 'error') throw new Error('socket hang up');
      throw new Error('unexpected probe for ' + m[1]);
    }
    return resp(404, '');
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
    XmlService: undefined,
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  };

  const patched = SRC
    .replace(/CHANNELS:\s*'[^']+'/, "CHANNELS: 'CHANNELS_ID'")
    .replace(/VIDEOS:\s*'[^']+'/, "VIDEOS: 'VIDEOS_ID'")
    .replace(/META:\s*'[^']+'/, "META: 'META_ID'");
  const factory = new Function(...Object.keys(globals), `${patched}\nreturn { crawlAllFeeds };`);
  return { ...factory(...Object.values(globals)), videosSheet, probed };
}

const urlOf = (be, id) => be.videosSheet._grid.find((r) => r[0] === id)[URL_COL];
const dataRows = (be) => be.videosSheet._grid.slice(1);

describe('Data-API fallback: new items are probed for Shorts before persisting', () => {
  it('writes /shorts/ for a Short and keeps watch?v= for long-form', () => {
    const be = loadCrawl({
      rss: 500, // YouTube blocks RSS from Apps Script IPs → Data API fallback
      playlist: ['8ois5twG3YY', 'NKtJ7kKBFG0'],
      probe: { '8ois5twG3YY': 'short', NKtJ7kKBFG0: 'long' },
    });
    const res = be.crawlAllFeeds();

    expect(res.new_videos).toBe(2);
    expect(urlOf(be, '8ois5twG3YY')).toBe(shorts('8ois5twG3YY'));
    expect(urlOf(be, 'NKtJ7kKBFG0')).toBe(watch('NKtJ7kKBFG0'));
    expect(be.probed.sort()).toEqual(['8ois5twG3YY', 'NKtJ7kKBFG0']);
  });

  it('probes only genuinely new items — never the already-stored window', () => {
    const be = loadCrawl({
      rss: 500,
      playlist: ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'],
      probe: { ccccccccccc: 'short' },
      videoRows: [row('aaaaaaaaaaa', watch('aaaaaaaaaaa')), row('bbbbbbbbbbb', shorts('bbbbbbbbbbb'))],
    });
    const res = be.crawlAllFeeds();

    expect(res.new_videos).toBe(1);
    expect(be.probed).toEqual(['ccccccccccc']); // one probe, for the one new id
    expect(urlOf(be, 'ccccccccccc')).toBe(shorts('ccccccccccc'));
    // Existing rows untouched either way — the Data API's watch URL is no evidence.
    expect(urlOf(be, 'aaaaaaaaaaa')).toBe(watch('aaaaaaaaaaa'));
    expect(urlOf(be, 'bbbbbbbbbbb')).toBe(shorts('bbbbbbbbbbb'));
  });

  it('an inconclusive probe (404, error, redirect loop) keeps the watch URL and still ingests', () => {
    const be = loadCrawl({
      rss: 500,
      playlist: ['ddddddddddd', 'eeeeeeeeeee', 'fffffffffff'],
      probe: { ddddddddddd: 'missing', eeeeeeeeeee: 'error', fffffffffff: 'loop' },
    });
    const res = be.crawlAllFeeds();

    expect(res.new_videos).toBe(3);
    expect(res.errors).toBe(0); // a failed probe never fails the channel
    for (const id of ['ddddddddddd', 'eeeeeeeeeee', 'fffffffffff']) {
      expect(urlOf(be, id)).toBe(watch(id));
    }
  });

  it('the RSS path never probes — the feed link is already authoritative', () => {
    const be = loadCrawl({
      rss: rss([shorts('8ois5twG3YY'), watch('NKtJ7kKBFG0')]),
      probe: {},
    });
    const res = be.crawlAllFeeds();

    expect(res.new_videos).toBe(2);
    expect(be.probed).toEqual([]);
    expect(urlOf(be, '8ois5twG3YY')).toBe(shorts('8ois5twG3YY'));
    expect(urlOf(be, 'NKtJ7kKBFG0')).toBe(watch('NKtJ7kKBFG0'));
  });
});

describe('self-heal: a stored watch URL is upgraded when RSS says /shorts/', () => {
  it('rewrites the url cell in place — no new row, no duplicate', () => {
    // 8ois5twG3YY was ingested through the Data API on a blocked crawl and
    // stored as watch?v=. The next crawl where RSS works lists it as a Short.
    const be = loadCrawl({
      rss: rss([shorts('8ois5twG3YY'), shorts('VLWHE0E7OOw'), watch('aP0zG-eTn0Q')]),
      videoRows: [
        row('8ois5twG3YY', watch('8ois5twG3YY')),   // misfiled → upgrade
        row('VLWHE0E7OOw', shorts('VLWHE0E7OOw')),  // already right → untouched
        row('aP0zG-eTn0Q', watch('aP0zG-eTn0Q')),   // long-form → untouched
      ],
    });
    const res = be.crawlAllFeeds();

    expect(res.new_videos).toBe(0);
    expect(dataRows(be)).toHaveLength(3);
    expect(urlOf(be, '8ois5twG3YY')).toBe(shorts('8ois5twG3YY'));
    expect(urlOf(be, 'VLWHE0E7OOw')).toBe(shorts('VLWHE0E7OOw'));
    expect(urlOf(be, 'aP0zG-eTn0Q')).toBe(watch('aP0zG-eTn0Q'));
    // Only the url cell changed on the repaired row.
    const repaired = dataRows(be).find((r) => r[0] === '8ois5twG3YY');
    const expected = row('8ois5twG3YY', shorts('8ois5twG3YY'));
    expect(repaired).toEqual(expected);
  });

  it('never downgrades: a watch URL arriving for a stored Short is ignored', () => {
    // The Data API emits watch?v= for everything, so this carries no information.
    const be = loadCrawl({
      rss: 500,
      playlist: ['VLWHE0E7OOw'],
      probe: {},
      videoRows: [row('VLWHE0E7OOw', shorts('VLWHE0E7OOw'))],
    });
    be.crawlAllFeeds();

    expect(urlOf(be, 'VLWHE0E7OOw')).toBe(shorts('VLWHE0E7OOw'));
    expect(be.probed).toEqual([]);
  });

  it('repairs several rows in one crawl and leaves the rest of the sheet intact', () => {
    const be = loadCrawl({
      rss: rss([shorts('aaaaaaaaaaa'), shorts('bbbbbbbbbbb'), shorts('ccccccccccc')]),
      videoRows: [
        row('xxxxxxxxxxx', watch('xxxxxxxxxxx')), // not in the feed any more → untouched
        row('aaaaaaaaaaa', watch('aaaaaaaaaaa')),
        row('bbbbbbbbbbb', watch('bbbbbbbbbbb')),
        row('ccccccccccc', shorts('ccccccccccc')),
      ],
    });
    be.crawlAllFeeds();

    expect(dataRows(be).map((r) => r[URL_COL])).toEqual([
      watch('xxxxxxxxxxx'), shorts('aaaaaaaaaaa'), shorts('bbbbbbbbbbb'), shorts('ccccccccccc'),
    ]);
  });
});
