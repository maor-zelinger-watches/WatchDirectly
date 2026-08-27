/**
 * Backend regressions for the be-normalize-paginate fix, exercised against the
 * SHIPPED apps-script/Code.gs (eval'd with injected GAS globals) so the tests
 * bind to the real functions, not reimplemented copies:
 *
 *   BE10 — normalizeVideoRows resolves an `item_id`-headed sheet into
 *          video.video_id, so dedupe, cursors, and ?v=<id> deep links work.
 *   BE13 — an empty Videos sheet is bootstrapped with the canonical header FIRST
 *          (incl. the live/premiere trio); a second crawl doesn't corrupt cells.
 *   BE14 — handleGetChannels publishes only whitelisted fields, so an
 *          operator-added column is never leaked to the anonymous response.
 *
 * XmlService is left undefined so parseRssFeed uses its regex fallback (no Java
 * XML runtime under Node). Everything is in-memory — nothing to clean up.
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
    getRange: (row, col, numRows, numCols) => ({
      // Faithful block read (real Sheets implements this): the batched crawl
      // flush reads a column/trio block via getRange(...).getValues().
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
      setNumberFormat() { return this; },
    }),
    appendRow: (r) => { grid.push(r.slice()); },
    getLastRow: () => grid.length,
  };
}

// Canonical Videos schema incl. the live trio (matches the header the fix writes
// when bootstrapping an empty sheet).
const CANONICAL_VIDEO_HEADERS = [
  'video_id', 'channel_name', 'title', 'url', 'published_at', 'fetched_at',
  'tier', 'category', 'comment_count', 'vote_count', 'media_type',
  'preview_image', 'view_count', 'live_status', 'scheduled_start', 'expires_at',
];

/**
 * Eval Code.gs with injected mocks and distinct CHANNELS / VIDEOS / META sheets.
 * @param opts.videosGrid    full 2-D Videos grid incl. header ([['']] = blank)
 * @param opts.channelsGrid  full 2-D Channels grid incl. header
 * @param opts.metaGrid      full 2-D Meta grid incl. header
 * @param opts.feeds         map feedUrl -> RSS xml (for crawlAllFeeds)
 * @param opts.broadcast     map youtubeId -> { status, scheduled }
 */
function load(opts = {}) {
  const channelsSheet = makeSheet(opts.channelsGrid || [
    ['channel_name', 'feed_url', 'tier', 'category', 'enabled'],
  ]);
  const videosSheet = makeSheet(opts.videosGrid || [CANONICAL_VIDEO_HEADERS.slice()]);
  const metaSheet = makeSheet(opts.metaGrid || [['key', 'value'], ['youtube_api_key', 'test-key']]);
  const sheets = { CHANNELS_ID: channelsSheet, VIDEOS_ID: videosSheet, META_ID: metaSheet };

  const feeds = opts.feeds || {};
  const broadcast = opts.broadcast || {};
  const fetch = (url) => {
    if (feeds[url]) return { getResponseCode: () => 200, getContentText: () => feeds[url] };
    if (url.indexOf('googleapis.com/youtube') !== -1) {
      const idMatch = url.match(/[?&]id=([^&]+)/);
      const ids = idMatch ? decodeURIComponent(idMatch[1]).split(',') : [];
      const items = ids.filter((id) => broadcast[id]).map((id) => ({
        id,
        snippet: { liveBroadcastContent: broadcast[id].status },
        liveStreamingDetails: broadcast[id].scheduled ? { scheduledStartTime: broadcast[id].scheduled } : {},
      }));
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ items }) };
    }
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

  const patched = SRC
    .replace(/CHANNELS:\s*'[^']+'/, "CHANNELS: 'CHANNELS_ID'")
    .replace(/VIDEOS:\s*'[^']+'/, "VIDEOS: 'VIDEOS_ID'")
    .replace(/META:\s*'[^']+'/, "META: 'META_ID'");

  const names = ['crawlAllFeeds', 'getVideos', 'handleVideo', 'normalizeVideoRows', 'handleGetChannels'];
  const factory = new Function(...Object.keys(globals), `${patched}\nreturn { ${names.join(', ')} };`);
  return { ...factory(...Object.values(globals)), sheets, videosSheet, channelsSheet, metaSheet };
}

/** RSS for a YouTube video, published `daysAgo` days ago (kept inside the prune window). */
function rssVideo(youtubeId, daysAgo = 1) {
  const pub = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toUTCString();
  return `<?xml version="1.0"?><rss version="2.0"><channel>
    <item><title>Vid ${youtubeId}</title>
    <link>https://www.youtube.com/watch?v=${youtubeId}</link>
    <pubDate>${pub}</pubDate></item>
  </channel></rss>`;
}

describe('BE10 — item_id-headed sheet normalizes into video.video_id', () => {
  // Two rows with NO url and DIFFERENT item_ids. Pre-fix, video.video_id was
  // undefined for both, so dedupeByUrl keyed both under 'id:undefined' and
  // collapsed them to one; cursors became "…|undefined" and ?v=<id> broke.
  const ITEM_HEADERS = ['item_id', 'channel_name', 'title', 'url', 'published_at', 'vote_count', 'comment_count', 'media_type'];
  const ROWS = [
    ['aaaaaaaaaaa', 'Chan', 'T1', '', '2026-01-02T00:00:00.000Z', 0, 0, 'video'],
    ['bbbbbbbbbbb', 'Chan', 'T2', '', '2026-01-01T00:00:00.000Z', 0, 0, 'video'],
  ];

  it('normalizeVideoRows populates video_id and does NOT collapse distinct url-less rows', () => {
    const be = load();
    const out = be.normalizeVideoRows([ITEM_HEADERS, ...ROWS]);
    expect(out).toHaveLength(2); // pre-fix both keyed 'id:undefined' -> length 1
    expect(out.map((v) => v.video_id)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
    expect(out.every((v) => v.video_id !== undefined)).toBe(true);
  });

  it('getVideos yields a real, undefined-free cursor', () => {
    const be = load({ videosGrid: [ITEM_HEADERS, ...ROWS] });
    const all = be.getVideos(1, 10, '');
    expect(all.total).toBe(2);
    expect(all.videos.map((v) => v.video_id)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);

    const page1 = be.getVideos(1, 1, '');
    expect(page1.next_cursor).toBe('2026-01-02T00:00:00.000Z|aaaaaaaaaaa');
    expect(page1.next_cursor).not.toContain('undefined');

    // The cursor resolves the very next item with no skip/repeat.
    const page2 = be.getVideos(2, 1, page1.next_cursor);
    expect(page2.videos.map((v) => v.video_id)).toEqual(['bbbbbbbbbbb']);
  });

  it('handleVideo resolves a ?v=<id> deep link against an item_id-headed sheet', () => {
    const be = load({ videosGrid: [ITEM_HEADERS, ...ROWS] });
    const res = be.handleVideo({ videoId: 'bbbbbbbbbbb' });
    expect(res.status).toBe('ok');
    expect(res.video).not.toBeNull();
    expect(res.video.video_id).toBe('bbbbbbbbbbb');
  });
});

describe('BE13 — empty Videos sheet is bootstrapped header-first', () => {
  function setup() {
    return load({
      channelsGrid: [
        ['channel_name', 'feed_url', 'tier', 'category', 'enabled'],
        ['Chan', 'https://feed.example/1', 0, 'Heavyweights', true],
      ],
      videosGrid: [['']], // a blank sheet reads back as [['']]
      feeds: { 'https://feed.example/1': rssVideo('AAAAAAAAAAA') },
      broadcast: { AAAAAAAAAAA: { status: 'none' } },
    });
  }

  it('writes the canonical header row first, then the data row', () => {
    const be = setup();
    const res = be.crawlAllFeeds();
    expect(res.new_videos).toBe(1);

    const grid = be.videosSheet._grid;
    expect(grid).toHaveLength(2);                    // header + one ingested row
    expect(grid[0]).toEqual(CANONICAL_VIDEO_HEADERS); // real header, not a data row
    // The live/premiere trio the old headerless fallback omitted is present.
    ['live_status', 'scheduled_start', 'expires_at'].forEach((c) => expect(grid[0]).toContain(c));
    expect(grid[1][0]).toBe('AAAAAAAAAAA');          // video_id under the video_id column
    expect(grid[1]).not.toContain('view_count');     // no header literal in a data cell
  });

  it('a second crawl does not corrupt the header or the data row', () => {
    const be = setup();
    be.crawlAllFeeds();
    be.crawlAllFeeds(); // same feed item — must dedupe, not re-append or overwrite

    const grid = be.videosSheet._grid;
    expect(grid).toHaveLength(2);                    // no duplicate row
    expect(grid[0]).toEqual(CANONICAL_VIDEO_HEADERS); // header intact
    expect(grid[1][0]).toBe('AAAAAAAAAAA');          // id cell not clobbered
    expect(grid[1]).not.toContain('view_count');     // no cell overwritten with a header literal
  });

  it('the bootstrapped rows read back cleanly through normalizeVideoRows', () => {
    const be = setup();
    be.crawlAllFeeds();
    const out = be.normalizeVideoRows(be.videosSheet._grid);
    expect(out).toHaveLength(1);
    expect(out[0].video_id).toBe('AAAAAAAAAAA');
    expect(out[0].title).toBe('Vid AAAAAAAAAAA');    // fields keyed by real header, not a title
  });
});

describe('BE14 — handleGetChannels publishes only whitelisted fields', () => {
  // Header carries operator-added columns (notes, contact_email, api_key) that
  // must never reach the anonymous response.
  const CH_HEADERS = ['channel_name', 'host', 'url', 'avatar', 'enabled', 'notes', 'contact_email', 'api_key'];

  it('omits operator-added columns, keeping only channel_name/host/url/avatar', () => {
    const be = load({
      channelsGrid: [CH_HEADERS, ['A', 'Host A', 'https://a.com', 'https://cdn/a.png', true, 'private note', 'ops@x.com', 'SECRETKEY']],
    });
    const ch = be.handleGetChannels().channels[0];
    expect(Object.keys(ch).sort()).toEqual(['avatar', 'channel_name', 'host', 'url']);
    expect(ch.notes).toBeUndefined();
    expect(ch.contact_email).toBeUndefined();
    expect(ch.api_key).toBeUndefined();
    expect(ch.channel_name).toBe('A');
    expect(ch.host).toBe('Host A');
    expect(ch.avatar).toBe('https://cdn/a.png');
  });

  it('still applies the favicon fallback for a non-YouTube channel with no avatar', () => {
    const be = load({
      channelsGrid: [CH_HEADERS, ['Worn & Wound', 'Various', 'https://www.wornandwound.com', '', true, 'note', '', '']],
    });
    const ch = be.handleGetChannels().channels[0];
    expect(ch.avatar).toBe('https://www.google.com/s2/favicons?domain=wornandwound.com&sz=128');
    expect(ch.notes).toBeUndefined(); // operator column still not leaked
  });
});
