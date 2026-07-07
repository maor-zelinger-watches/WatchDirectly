/**
 * Unit tests for js/feed.js
 * 
 * Tests cover:
 * - createMediaCard(): HTML generation for feed cards (video + article)
 * - sortVideos(): chronological sorting
 * - Iframe attributes (lazy loading via data-src, nocookie domain)
 */

import { describe, it, expect } from 'vitest';
import { createMediaCard, sortVideos, filterVideos, isShort, mediaType, dedupeVideos } from '../../js/feed.js';

const mockVideo = {
  video_id: 'abc12345678',
  channel_name: 'Teddy Baldassarre',
  title: 'Top 10 Watches Under $500',
  url: 'https://www.youtube.com/watch?v=abc12345678',
  published_at: '2026-05-07T08:00:00Z',
  tier: 0,
  category: 'The Heavyweights & Entertainment',
  comment_count: 12,
  media_type: 'video',
};

const mockArticle = {
  video_id: 'aW50ZXJlc3Rpbmc',
  channel_name: 'Hodinkee',
  title: 'The Rise of Microbrands',
  url: 'https://www.hodinkee.com/articles/rise-of-microbrands',
  published_at: '2026-05-07T09:00:00Z',
  tier: 1,
  category: 'Journalism',
  comment_count: 3,
  media_type: 'article',
  preview_image: 'https://cdn.hodinkee.com/image.jpg',
};

const mockVideos = [
  { ...mockVideo, video_id: 'v1aaaaaaaaa', published_at: '2026-05-07T08:00:00Z', channel_name: 'A' },
  { ...mockVideo, video_id: 'v2bbbbbbbbb', published_at: '2026-05-07T10:00:00Z', channel_name: 'B' },
  { ...mockVideo, video_id: 'v3ccccccccc', published_at: '2026-05-06T12:00:00Z', channel_name: 'C' },
  { ...mockVideo, video_id: 'v4ddddddddd', published_at: '2026-05-07T14:00:00Z', channel_name: 'D' },
];

describe('createMediaCard (video)', () => {
  it('returns an HTML string containing the video title', () => {
    const html = createMediaCard(mockVideo);
    expect(html).toContain('Top 10 Watches Under $500');
  });

  it('includes a YouTube embed iframe with data-src', () => {
    const html = createMediaCard(mockVideo);
    expect(html).toContain('<iframe');
    expect(html).toContain('youtube-nocookie.com/embed/abc12345678');
    expect(html).toContain('data-src=');
  });

  it('includes the channel name', () => {
    const html = createMediaCard(mockVideo);
    expect(html).toContain('Teddy Baldassarre');
  });

  it('includes the comment count', () => {
    const html = createMediaCard(mockVideo);
    expect(html).toContain('12');
  });

  it('includes the category', () => {
    const html = createMediaCard(mockVideo);
    expect(html).toContain('Heavyweights');
  });

  it('includes data-video-id attribute', () => {
    const html = createMediaCard(mockVideo);
    expect(html).toContain('data-video-id="abc12345678"');
  });

  it('escapes HTML in title to prevent XSS', () => {
    const xssVideo = { ...mockVideo, title: '<script>alert("xss")</script>' };
    const html = createMediaCard(xssVideo);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('includes an upvote button showing the vote count', () => {
    const html = createMediaCard({ ...mockVideo, vote_count: 7 });
    expect(html).toContain('media-card__vote');
    expect(html).toContain('media-card__vote-count');
    expect(html).toContain('>7<');
  });

  it('defaults the vote count to 0 when absent', () => {
    const { vote_count, ...noVotes } = mockVideo;
    const html = createMediaCard(noVotes);
    expect(html).toContain('media-card__vote-count');
    expect(html).toMatch(/media-card__vote-count">0</);
  });

  it('shows a formatted view count when present', () => {
    const html = createMediaCard({ ...mockVideo, view_count: 52300 });
    expect(html).toContain('media-card__views');
    expect(html).toContain('52.3K views');
  });

  it('omits the views element when the count is absent or zero', () => {
    expect(createMediaCard(mockVideo)).not.toContain('media-card__views');
    expect(createMediaCard({ ...mockVideo, view_count: 0 })).not.toContain('media-card__views');
  });

  it('includes a star button carrying the channel name', () => {
    const html = createMediaCard(mockVideo);
    expect(html).toContain('media-card__star');
    expect(html).toContain('data-channel="Teddy Baldassarre"');
  });

  it('includes an expand button', () => {
    const html = createMediaCard(mockVideo);
    expect(html).toContain('media-card__expand');
  });

  it('marks shorts with the media-card--short class', () => {
    const short = { ...mockVideo, url: 'https://www.youtube.com/shorts/abc12345678' };
    expect(createMediaCard(short)).toContain('media-card--short');
    expect(createMediaCard(mockVideo)).not.toContain('media-card--short');
  });
});

describe('isShort', () => {
  it('detects shorts by their /shorts/ URL', () => {
    expect(isShort({ ...mockVideo, url: 'https://www.youtube.com/shorts/abc12345678' })).toBe(true);
  });

  it('treats watch URLs as long-form', () => {
    expect(isShort(mockVideo)).toBe(false);
  });

  it('never flags articles, even with shorts-like URLs', () => {
    expect(isShort({ ...mockArticle, url: 'https://example.com/shorts/story' })).toBe(false);
  });

  it('handles missing url and null items', () => {
    expect(isShort({ ...mockVideo, url: undefined })).toBe(false);
    expect(isShort(null)).toBe(false);
  });
});

describe('createMediaCard (article)', () => {
  it('renders an article card with image', () => {
    const html = createMediaCard(mockArticle);
    expect(html).toContain('article-card');
    expect(html).toContain('cdn.hodinkee.com/image.jpg');
    expect(html).toContain('Read Article');
  });

  it('renders a placeholder when no preview image', () => {
    const noImage = { ...mockArticle, preview_image: '' };
    const html = createMediaCard(noImage);
    expect(html).toContain('article-card__placeholder');
    expect(html).not.toContain('<img');
  });

  it('rejects javascript: URLs', () => {
    const xssArticle = { ...mockArticle, url: 'javascript:alert(1)' };
    const html = createMediaCard(xssArticle);
    expect(html).not.toContain('javascript:');
  });
});

describe('filterVideos', () => {
  const catalog = [
    { ...mockVideo, video_id: 'f1aaaaaaaaa', title: 'Tudor Black Bay 58 Review', channel_name: 'Teddy Baldassarre', category: 'The Heavyweights & Entertainment' },
    { ...mockVideo, video_id: 'f2bbbbbbbbb', title: 'Best Budget Watches 2026', channel_name: 'Just One More Watch', category: 'The Affordable & "Value" Kings' },
    { ...mockVideo, video_id: 'f3ccccccccc', title: 'Reacting to a $1M Collection', channel_name: 'Nico Leonard', category: 'The Heavyweights & Entertainment' },
  ];

  it('matches query against the title, case-insensitive', () => {
    const result = filterVideos(catalog, { query: 'tudor' });
    expect(result).toHaveLength(1);
    expect(result[0].video_id).toBe('f1aaaaaaaaa');
  });

  it('matches query against the channel name', () => {
    const result = filterVideos(catalog, { query: 'nico' });
    expect(result).toHaveLength(1);
    expect(result[0].video_id).toBe('f3ccccccccc');
  });

  it('returns everything for an empty filter', () => {
    expect(filterVideos(catalog, {})).toHaveLength(3);
    expect(filterVideos(catalog)).toHaveLength(3);
  });

  it('treats whitespace-only query as empty', () => {
    expect(filterVideos(catalog, { query: '   ' })).toHaveLength(3);
  });

  it('returns empty array when nothing matches', () => {
    expect(filterVideos(catalog, { query: 'submariner' })).toEqual([]);
  });

  it('handles items with missing title or channel', () => {
    const sparse = [{ video_id: 'x1' }];
    expect(filterVideos(sparse, { query: 'anything' })).toEqual([]);
    expect(filterVideos(sparse, {})).toHaveLength(1);
  });

  it('matches the channel host via hostsByChannel ("Adrian" finds Bark and Jack)', () => {
    const withHostChannel = [
      ...catalog,
      { ...mockVideo, video_id: 'f4ddddddddd', title: 'GMT Showdown', channel_name: 'Bark and Jack' },
    ];
    const hosts = { 'Bark and Jack': 'Adrian Barker' };

    const result = filterVideos(withHostChannel, { query: 'adrian', hostsByChannel: hosts });
    expect(result).toHaveLength(1);
    expect(result[0].video_id).toBe('f4ddddddddd');
  });

  it('host matching is harmless when the map is missing or has no entry', () => {
    expect(filterVideos(catalog, { query: 'adrian' })).toEqual([]);
    expect(filterVideos(catalog, { query: 'adrian', hostsByChannel: {} })).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const original = [...catalog];
    filterVideos(catalog, { query: 'tudor' });
    expect(catalog).toEqual(original);
  });
});

describe('mediaType', () => {
  const video = { ...mockVideo };
  const article = { ...mockArticle };
  const short = { ...mockVideo, video_id: 'sh0rtvid001', url: 'https://www.youtube.com/shorts/sh0rtvid001' };
  // An article whose media_type is missing but whose id is > 11 chars (the
  // createMediaCard fallback) must still classify as an article, never a short.
  const idFallbackArticle = { video_id: 'aGVsbG93b3JsZA', url: 'https://example.com/read' };

  it('classifies long-form videos as "video"', () => {
    expect(mediaType(video)).toBe('video');
  });

  it('classifies media_type "article" as "article"', () => {
    expect(mediaType(article)).toBe('article');
  });

  it('classifies /shorts/ URLs as "short"', () => {
    expect(mediaType(short)).toBe('short');
  });

  it('treats a long id as an article even without media_type', () => {
    expect(mediaType(idFallbackArticle)).toBe('article');
  });

  it('is null-safe', () => {
    expect(mediaType(null)).toBe('video');
    expect(mediaType(undefined)).toBe('video');
  });
});

describe('createMediaCard (content-type stamp)', () => {
  // The type chips hide cards with pure CSS (.feed--hide-<type>), so every
  // card must carry its classification as a data attribute.
  it('stamps long-form videos with data-media-type="video"', () => {
    expect(createMediaCard(mockVideo)).toContain('data-media-type="video"');
  });

  it('stamps articles with data-media-type="article"', () => {
    expect(createMediaCard(mockArticle)).toContain('data-media-type="article"');
  });

  it('stamps shorts with data-media-type="short"', () => {
    const short = { ...mockVideo, video_id: 'sh0rtvid001', url: 'https://www.youtube.com/shorts/sh0rtvid001' };
    expect(createMediaCard(short)).toContain('data-media-type="short"');
  });
});

describe('filterVideos (fuzzy matching)', () => {
  const catalog = [
    { ...mockVideo, video_id: 'z1aaaaaaaaa', title: 'Explained by Veritasium', channel_name: 'Veritasium' },
    { ...mockVideo, video_id: 'z2bbbbbbbbb', title: 'Best Budget Watches 2026', channel_name: 'Just One More Watch' },
    { ...mockVideo, video_id: 'z3ccccccccc', title: 'Café Racer Restoration', channel_name: 'Nico Leonard' },
  ];

  it('tolerates a single-character typo (insertion)', () => {
    // "veritasum" is missing the second "i" of "Veritasium"
    const result = filterVideos(catalog, { query: 'veritasum' });
    expect(result.map(v => v.video_id)).toContain('z1aaaaaaaaa');
  });

  it('tolerates a single-character typo (substitution)', () => {
    const result = filterVideos(catalog, { query: 'budgt' }); // dropped the "e"
    expect(result.map(v => v.video_id)).toContain('z2bbbbbbbbb');
  });

  it('is diacritic-insensitive both ways', () => {
    expect(filterVideos(catalog, { query: 'cafe' }).map(v => v.video_id)).toContain('z3ccccccccc');
    expect(filterVideos(catalog, { query: 'café' }).map(v => v.video_id)).toContain('z3ccccccccc');
  });

  it('does not fuzzy-match a distant word (no false positives)', () => {
    expect(filterVideos(catalog, { query: 'submariner' })).toEqual([]);
  });

  it('does not fuzzy-match short tokens (guards against noise)', () => {
    // "cat" is one edit from "café" but too short to fuzzy-match — and it is
    // not a substring of any field, so it must not match.
    expect(filterVideos(catalog, { query: 'cat' })).toEqual([]);
  });

  it('requires every query token to match (AND semantics)', () => {
    expect(filterVideos(catalog, { query: 'budget watches' }).map(v => v.video_id)).toEqual(['z2bbbbbbbbb']);
    expect(filterVideos(catalog, { query: 'budget helicopter' })).toEqual([]);
  });

  it('ranks a title hit above a channel-only hit', () => {
    const ranked = [
      { ...mockVideo, video_id: 'r1', title: 'Nothing relevant here', channel_name: 'Watchmojo' },
      { ...mockVideo, video_id: 'r2', title: 'Watch Review Roundup', channel_name: 'Some Channel' },
    ];
    const result = filterVideos(ranked, { query: 'watch' });
    expect(result[0].video_id).toBe('r2'); // title match outranks channel match
  });
});

describe('sortVideos', () => {
  it('sorts videos in reverse chronological order (newest first)', () => {
    const sorted = sortVideos([...mockVideos]);
    expect(sorted[0].video_id).toBe('v4ddddddddd'); // 14:00
    expect(sorted[1].video_id).toBe('v2bbbbbbbbb'); // 10:00
    expect(sorted[2].video_id).toBe('v1aaaaaaaaa'); // 08:00
    expect(sorted[3].video_id).toBe('v3ccccccccc'); // yesterday
  });

  it('does not mutate the original array', () => {
    const original = [...mockVideos];
    const originalIds = original.map(v => v.video_id);
    sortVideos(original);
    expect(original.map(v => v.video_id)).toEqual(originalIds);
  });

  it('handles empty array', () => {
    expect(sortVideos([])).toEqual([]);
  });

  it('handles single item', () => {
    const result = sortVideos([mockVideo]);
    expect(result).toHaveLength(1);
  });
});

describe('dedupeVideos (same article under two ids)', () => {
  // The real-world bug: an article-ID scheme change orphaned old rows, so the
  // same url arrived twice under different video_ids and rendered doubled.
  const chopardOld = { video_id: 'tLz9wPTMxMzA2MQ', url: 'https://monochrome-watches.com/2026-chopard-mille/', vote_count: 1, comment_count: 0, published_at: '2026-07-07T00:00:00Z' };
  const chopardNew = { video_id: 'Ic50sgzdI3jc5Kt', url: 'https://monochrome-watches.com/2026-chopard-mille/', vote_count: 0, comment_count: 0, published_at: '2026-07-07T00:00:00Z' };

  it('collapses two ids that share a url into one entry', () => {
    const result = dedupeVideos([chopardOld, chopardNew]);
    expect(result).toHaveLength(1);
  });

  it('keeps the most-engaged copy (votes win)', () => {
    // Order-independent: the vote-1 row survives whether it is seen first or last.
    expect(dedupeVideos([chopardOld, chopardNew])[0].video_id).toBe('tLz9wPTMxMzA2MQ');
    expect(dedupeVideos([chopardNew, chopardOld])[0].video_id).toBe('tLz9wPTMxMzA2MQ');
  });

  it('breaks vote ties by comment count', () => {
    const a = { video_id: 'a', url: 'https://x/1', vote_count: 0, comment_count: 5 };
    const b = { video_id: 'b', url: 'https://x/1', vote_count: 0, comment_count: 2 };
    expect(dedupeVideos([b, a])[0].video_id).toBe('a');
  });

  it('treats urls case/whitespace-insensitively', () => {
    const a = { video_id: 'a', url: 'https://X/1 ', vote_count: 0 };
    const b = { video_id: 'b', url: 'https://x/1', vote_count: 1 };
    const result = dedupeVideos([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0].video_id).toBe('b');
  });

  it('never merges distinct urls, and preserves first-seen order', () => {
    const one = { video_id: '1', url: 'https://x/1', vote_count: 0 };
    const two = { video_id: '2', url: 'https://x/2', vote_count: 0 };
    const result = dedupeVideos([one, two]);
    expect(result.map(v => v.video_id)).toEqual(['1', '2']);
  });

  it('keeps url-less items apart by keying on their id', () => {
    const a = { video_id: 'a', url: '', vote_count: 0 };
    const b = { video_id: 'b', url: '', vote_count: 0 };
    expect(dedupeVideos([a, b])).toHaveLength(2);
  });

  it('leaves YouTube items (distinct stable ids, distinct urls) untouched', () => {
    const distinct = mockVideos.map(v => ({ ...v, url: `https://www.youtube.com/watch?v=${v.video_id}` }));
    const result = dedupeVideos(distinct);
    expect(result).toHaveLength(distinct.length);
  });
});

describe('createMediaCard (XSS — finding #5)', () => {
  it('escapes a quote-breakout payload in the video title-link href', () => {
    const html = createMediaCard({ ...mockVideo, url: 'https://evil.example/"><img src=x onerror=alert(1)>' });
    // The raw breakout must not survive into the markup...
    expect(html).not.toContain('"><img src=x onerror=alert(1)>');
    // ...it must be entity-escaped so it stays inside the href attribute.
    expect(html).toContain('&quot;&gt;&lt;img');
  });

  it('escapes a quote-breakout payload in data-published-at', () => {
    const html = createMediaCard({ ...mockVideo, published_at: '2026"><script>alert(1)</script>' });
    expect(html).not.toContain('"><script>');
    expect(html).toContain('data-published-at="2026&quot;&gt;&lt;script&gt;');
  });

  it('leaves a normal https URL intact in the href', () => {
    const html = createMediaCard(mockVideo);
    expect(html).toContain('href="https://www.youtube.com/watch?v=abc12345678"');
  });
});
