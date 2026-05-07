/**
 * Unit tests for js/feed.js
 * 
 * Tests cover:
 * - createVideoCard(): HTML generation for feed cards
 * - sortVideos(): chronological sorting
 * - filterVideos(): tier/category filtering
 * - Iframe attributes (lazy loading, nocookie domain)
 */

import { describe, it, expect } from 'vitest';
import { createVideoCard, sortVideos, filterVideos } from '../../js/feed.js';

const mockVideo = {
  video_id: 'abc123',
  channel_name: 'Teddy Baldassarre',
  title: 'Top 10 Watches Under $500',
  url: 'https://www.youtube.com/watch?v=abc123',
  published_at: '2026-05-07T08:00:00Z',
  tier: 0,
  category: 'The Heavyweights & Entertainment',
  comment_count: 12,
};

const mockVideos = [
  { ...mockVideo, video_id: 'v1', published_at: '2026-05-07T08:00:00Z', channel_name: 'A' },
  { ...mockVideo, video_id: 'v2', published_at: '2026-05-07T10:00:00Z', channel_name: 'B' },
  { ...mockVideo, video_id: 'v3', published_at: '2026-05-06T12:00:00Z', channel_name: 'C' },
  { ...mockVideo, video_id: 'v4', published_at: '2026-05-07T14:00:00Z', channel_name: 'D' },
];

describe('createVideoCard', () => {
  it('returns an HTML string containing the video title', () => {
    const html = createVideoCard(mockVideo);
    expect(html).toContain('Top 10 Watches Under $500');
  });

  it('includes a YouTube embed iframe', () => {
    const html = createVideoCard(mockVideo);
    expect(html).toContain('<iframe');
    expect(html).toContain('youtube-nocookie.com/embed/abc123');
  });

  it('uses lazy loading on the iframe', () => {
    const html = createVideoCard(mockVideo);
    expect(html).toContain('loading="lazy"');
  });

  it('includes the channel name', () => {
    const html = createVideoCard(mockVideo);
    expect(html).toContain('Teddy Baldassarre');
  });

  it('includes the comment count', () => {
    const html = createVideoCard(mockVideo);
    expect(html).toContain('12');
  });

  it('includes a tier badge', () => {
    const html = createVideoCard(mockVideo);
    expect(html).toContain('Tier 0');
  });

  it('includes the category', () => {
    const html = createVideoCard(mockVideo);
    expect(html).toContain('Heavyweights');
  });

  it('includes data-video-id attribute for routing', () => {
    const html = createVideoCard(mockVideo);
    expect(html).toContain('data-video-id="abc123"');
  });
});

describe('sortVideos', () => {
  it('sorts videos in reverse chronological order (newest first)', () => {
    const sorted = sortVideos([...mockVideos]);
    expect(sorted[0].video_id).toBe('v4'); // 14:00
    expect(sorted[1].video_id).toBe('v2'); // 10:00
    expect(sorted[2].video_id).toBe('v1'); // 08:00
    expect(sorted[3].video_id).toBe('v3'); // yesterday
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

describe('filterVideos', () => {
  const videosWithTiers = [
    { ...mockVideo, video_id: 'a', tier: 0 },
    { ...mockVideo, video_id: 'b', tier: 1 },
    { ...mockVideo, video_id: 'c', tier: 2 },
    { ...mockVideo, video_id: 'd', tier: 3 },
    { ...mockVideo, video_id: 'e', tier: 0 },
  ];

  it('returns all videos when filter is "all"', () => {
    const result = filterVideos(videosWithTiers, 'all');
    expect(result).toHaveLength(5);
  });

  it('filters by specific tier', () => {
    const result = filterVideos(videosWithTiers, 0);
    expect(result).toHaveLength(2);
    expect(result.every(v => v.tier === 0)).toBe(true);
  });

  it('filters tier 3', () => {
    const result = filterVideos(videosWithTiers, 3);
    expect(result).toHaveLength(1);
    expect(result[0].video_id).toBe('d');
  });

  it('returns empty array if no matches', () => {
    const result = filterVideos(videosWithTiers, 99);
    expect(result).toHaveLength(0);
  });
});
