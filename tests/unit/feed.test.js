/**
 * Unit tests for js/feed.js
 * 
 * Tests cover:
 * - createMediaCard(): HTML generation for feed cards (video + article)
 * - sortVideos(): chronological sorting
 * - Iframe attributes (lazy loading via data-src, nocookie domain)
 */

import { describe, it, expect } from 'vitest';
import { createMediaCard, sortVideos, filterVideos } from '../../js/feed.js';

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

  it('filters by exact category', () => {
    const result = filterVideos(catalog, { category: 'The Heavyweights & Entertainment' });
    expect(result).toHaveLength(2);
  });

  it('combines query and category', () => {
    const result = filterVideos(catalog, { query: 'collection', category: 'The Heavyweights & Entertainment' });
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
    const sparse = [{ video_id: 'x1', category: 'Misc' }];
    expect(filterVideos(sparse, { query: 'anything' })).toEqual([]);
    expect(filterVideos(sparse, { category: 'Misc' })).toHaveLength(1);
  });

  it('does not mutate the input array', () => {
    const original = [...catalog];
    filterVideos(catalog, { query: 'tudor' });
    expect(catalog).toEqual(original);
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
