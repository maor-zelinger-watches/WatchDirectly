/**
 * Unit tests for the Data-API feed path (Backend feed fetching).
 *
 * YouTube serves 404/500 to youtube.com/feeds/videos.xml requests coming from
 * Apps Script's datacenter IPs, so the RSS crawl fails wholesale. fetchAndParseFeed
 * now routes YouTube channel feeds through the Data API's playlistItems.list on
 * the channel's uploads playlist (the keyed googleapis.com endpoint, which isn't
 * IP-blocked), and keeps plain RSS for non-YouTube feeds and for the no-key case.
 *
 * Exercises the SHIPPED Code.gs the same way the other backend tests do: load the
 * source, patch the META spreadsheet id to an in-memory sentinel, mock the Apps
 * Script globals, and let the real getMeta/log run. log_level=ERROR makes the
 * WARN-level retry logs no-op so no LOGS sheet is needed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');

/** A minimal in-memory sheet backed by a 2-D array. */
function makeSheet(rows) {
  const grid = rows.map((r) => r.slice());
  return {
    _grid: grid,
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    appendRow: (r) => { grid.push(r.slice()); },
  };
}

function resp(code, text) {
  return { getResponseCode: () => code, getContentText: () => text };
}
const ok = (text) => resp(200, text);

/**
 * Loads the backend with a mocked environment.
 * @param {object} [opts]
 * @param {string} [opts.apiKey] value stored at META youtube_api_key ('' = unset)
 * @param {(url:string)=>object} [opts.fetch] UrlFetchApp.fetch handler
 */
function load(opts = {}) {
  const apiKey = opts.apiKey === undefined ? 'KEY123' : opts.apiKey;
  const meta = [['key', 'value'], ['log_level', 'ERROR']];
  if (apiKey) meta.push(['youtube_api_key', apiKey]);

  const sheets = { META_ID: makeSheet(meta) };
  const calls = [];
  const fetch = (url) => {
    calls.push(url);
    return (opts.fetch || (() => ok('{"items":[]}')))(url);
  };

  const globals = {
    UrlFetchApp: { fetch },
    SpreadsheetApp: { openById: (id) => ({ getSheets: () => [sheets[id]] }) },
    Utilities: {
      sleep() {},
      // parseRss2/parseAtom/parseRegex hash the item link unconditionally.
      computeDigest: (_algo, str) => Array.from(String(str)).map((c) => c.charCodeAt(0) & 0xff),
      DigestAlgorithm: { MD5: 'MD5' },
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64'),
    },
    Logger: { log() {} },
    XmlService: undefined, // RSS fallback degrades to parseRegex, which is enough here
  };

  const patched = SRC.replace(/META:\s*'[^']+'/, "META: 'META_ID'");
  const names = ['extractFeedChannelId', 'fetchYouTubeUploads', 'parseYouTubeUploads', 'fetchAndParseFeed'];
  const factory = new Function(...Object.keys(globals), `${patched}\nreturn { ${names.join(', ')} };`);
  return { ...factory(...Object.values(globals)), calls };
}

// Two real uploads, one private placeholder, one malformed (no videoId).
const PLAYLIST_JSON = JSON.stringify({
  items: [
    {
      snippet: {
        title: 'Rolex &amp; Tudor — new for 2026',
        publishedAt: '2026-07-08T09:00:00Z',
        thumbnails: {
          high: { url: 'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg' },
          maxres: { url: 'https://i.ytimg.com/vi/aaaaaaaaaaa/maxresdefault.jpg' },
        },
        resourceId: { videoId: 'aaaaaaaaaaa' },
      },
      contentDetails: { videoId: 'aaaaaaaaaaa', videoPublishedAt: '2026-07-08T08:30:00Z' },
    },
    {
      snippet: {
        title: 'Second video',
        publishedAt: '2026-07-01T10:00:00Z',
        thumbnails: { default: { url: 'https://i.ytimg.com/vi/bbbbbbbbbbb/default.jpg' } },
      },
      contentDetails: { videoId: 'bbbbbbbbbbb' },
    },
    { snippet: { title: 'Private video', thumbnails: {} }, contentDetails: { videoId: 'ccccccccccc' } },
    { snippet: { title: 'Orphaned entry', thumbnails: {} }, contentDetails: {} },
  ],
});

describe('extractFeedChannelId', () => {
  const be = load();

  it('pulls the UC… id from a youtube videos.xml feed url', () => {
    expect(be.extractFeedChannelId('https://www.youtube.com/feeds/videos.xml?channel_id=UCXPXfAAo-yV6Y-0PZecwBLw'))
      .toBe('UCXPXfAAo-yV6Y-0PZecwBLw');
  });

  it('handles extra query params in any order', () => {
    expect(be.extractFeedChannelId('https://www.youtube.com/feeds/videos.xml?foo=bar&channel_id=UC0ulDfOIUVoZAhHPuCTiawg&x=1'))
      .toBe('UC0ulDfOIUVoZAhHPuCTiawg');
  });

  it('returns "" for non-youtube (blog/news) feeds', () => {
    expect(be.extractFeedChannelId('https://www.hodinkee.com/rss')).toBe('');
    expect(be.extractFeedChannelId('https://wornandwound.com/feed/')).toBe('');
  });

  it('returns "" for blank/undefined input', () => {
    expect(be.extractFeedChannelId('')).toBe('');
    expect(be.extractFeedChannelId(undefined)).toBe('');
  });
});

describe('parseYouTubeUploads', () => {
  const be = load();
  const videos = be.parseYouTubeUploads(PLAYLIST_JSON, 'Nico Leonard', 1, 'Reviews');

  it('drops private and videoId-less entries', () => {
    expect(videos.map((v) => v.video_id)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  });

  it('maps into the parseAtom item shape (with &amp; decoded)', () => {
    expect(videos[0]).toMatchObject({
      video_id: 'aaaaaaaaaaa',
      media_type: 'video',
      channel_name: 'Nico Leonard',
      title: 'Rolex & Tudor — new for 2026',
      url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      tier: 1,
      category: 'Reviews',
      view_count: 0,
    });
  });

  it('prefers the highest-res thumbnail', () => {
    expect(videos[0].preview_image).toBe('https://i.ytimg.com/vi/aaaaaaaaaaa/maxresdefault.jpg');
  });

  it('prefers contentDetails.videoPublishedAt for the timestamp', () => {
    expect(videos[0].published_at).toBe('2026-07-08T08:30:00.000Z');
  });

  it('falls back to snippet.publishedAt when videoPublishedAt is absent', () => {
    expect(videos[1].published_at).toBe('2026-07-01T10:00:00.000Z');
  });

  it('returns [] for an empty item list', () => {
    expect(be.parseYouTubeUploads('{"items":[]}', 'X', 0, 'c')).toEqual([]);
  });
});

describe('fetchYouTubeUploads', () => {
  it('hits playlistItems.list on the UU uploads playlist and returns parsed items', () => {
    const be = load({ fetch: () => ok(PLAYLIST_JSON) });
    const videos = be.fetchYouTubeUploads('UCXPXfAAo-yV6Y-0PZecwBLw', 'Nico', 1, 'Reviews', 'KEY123');

    expect(videos.map((v) => v.video_id)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
    expect(be.calls.length).toBe(1);
    const url = be.calls[0];
    expect(url).toContain('https://www.googleapis.com/youtube/v3/playlistItems');
    expect(url).toContain('playlistId=UUXPXfAAo-yV6Y-0PZecwBLw'); // UC -> UU
    expect(url).toContain('key=KEY123');
    expect(url).toContain('part=snippet,contentDetails');
  });

  it('retries then throws HTTP 500 on a persistent server error', () => {
    const be = load({ fetch: () => resp(500, 'err') });
    expect(() => be.fetchYouTubeUploads('UCabc', 'X', 0, 'c', 'KEY')).toThrow('HTTP 500');
    expect(be.calls.length).toBe(5); // 1 + 4 retries
  });

  it('fails fast (no retry) on 404 — deleted/renamed channel', () => {
    const be = load({ fetch: () => resp(404, 'err') });
    expect(() => be.fetchYouTubeUploads('UCabc', 'X', 0, 'c', 'KEY')).toThrow('HTTP 404');
    expect(be.calls.length).toBe(1);
  });

  it('fails fast (no retry) on 403 — quota/key', () => {
    const be = load({ fetch: () => resp(403, 'err') });
    expect(() => be.fetchYouTubeUploads('UCabc', 'X', 0, 'c', 'KEY')).toThrow('HTTP 403');
    expect(be.calls.length).toBe(1);
  });
});

describe('fetchAndParseFeed routing (RSS first, Data API fallback)', () => {
  const YT_FEED = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCXPXfAAo-yV6Y-0PZecwBLw';
  const BLOG_FEED = 'https://www.hodinkee.com/rss';
  // RSS2 with one youtube item so the shipped parseRegex fallback yields a video
  // (XmlService is unmocked, so parseRssFeed degrades to parseRegex).
  const RSS_ONE_ITEM =
    '<rss><channel><item><title>Hello World</title>' +
    '<link>https://youtu.be/zzzzzzzzzzz</link>' +
    '<pubDate>Tue, 08 Jul 2026 09:00:00 GMT</pubDate></item></channel></rss>';

  // A fetch handler that answers RSS and Data-API URLs separately.
  const router = ({ rss, api }) => (url) =>
    url.includes('googleapis.com') ? api(url) : rss(url);
  const hitApi = (calls) => calls.some((u) => u.includes('googleapis.com'));
  const rssHits = (calls) => calls.filter((u) => !u.includes('googleapis.com')).length;

  it('uses RSS and does NOT touch the Data API when RSS works', () => {
    const be = load({ apiKey: 'KEY', fetch: router({ rss: () => ok(RSS_ONE_ITEM), api: () => ok(PLAYLIST_JSON) }) });
    const videos = be.fetchAndParseFeed(YT_FEED, 'Nico', 1, 'Reviews');

    expect(hitApi(be.calls)).toBe(false);
    expect(be.calls[0]).toBe(YT_FEED);
    expect(videos.map((v) => v.video_id)).toEqual(['zzzzzzzzzzz']); // from RSS
  });

  it('falls back to the Data API when RSS errors — single RSS attempt, no 30s retry', () => {
    const be = load({ apiKey: 'KEY', fetch: router({ rss: () => resp(500, 'x'), api: () => ok(PLAYLIST_JSON) }) });
    const videos = be.fetchAndParseFeed(YT_FEED, 'Nico', 1, 'Reviews');

    expect(rssHits(be.calls)).toBe(1); // RSS tried once, not 5x
    expect(hitApi(be.calls)).toBe(true);
    expect(videos.map((v) => v.video_id)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']); // from API
  });

  it('falls back to the Data API when RSS returns 200 but zero items', () => {
    const be = load({ apiKey: 'KEY', fetch: router({ rss: () => ok('<rss></rss>'), api: () => ok(PLAYLIST_JSON) }) });
    const videos = be.fetchAndParseFeed(YT_FEED, 'Nico', 1, 'Reviews');

    expect(hitApi(be.calls)).toBe(true);
    expect(videos.length).toBe(2);
  });

  it('YouTube feed with NO key: RSS only (full retries), never the Data API', () => {
    const be = load({ apiKey: '', fetch: router({ rss: () => resp(500, 'x'), api: () => ok(PLAYLIST_JSON) }) });

    expect(() => be.fetchAndParseFeed(YT_FEED, 'Nico', 1, 'Reviews')).toThrow('HTTP 500');
    expect(hitApi(be.calls)).toBe(false);
    expect(rssHits(be.calls)).toBe(5); // 1 + 4 retries
  });

  it('non-YouTube feed: RSS only, never the Data API even with a key', () => {
    const be = load({ apiKey: 'KEY', fetch: router({ rss: () => ok(RSS_ONE_ITEM), api: () => ok(PLAYLIST_JSON) }) });
    const videos = be.fetchAndParseFeed(BLOG_FEED, 'Hodinkee', 1, 'News');

    expect(be.calls[0]).toBe(BLOG_FEED);
    expect(hitApi(be.calls)).toBe(false);
    expect(videos.length).toBe(1);
  });
});
