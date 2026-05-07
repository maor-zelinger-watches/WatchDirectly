/**
 * Production Feed Health Tests
 *
 * Verifies that the live API returns fresh, diverse content:
 *   1. Feed has recent items (not stale)
 *   2. Articles from blog RSS feeds appear alongside videos
 *   3. No broken/empty items
 *
 * These tests hit the REAL production API — no mocks.
 */

import { test, expect } from '@playwright/test';

const API_URL = 'https://script.google.com/macros/s/AKfycbwyt7c8SWw9y0TnKq4RhcV7yLjS1JkXnNThYInpj-EnNYbA3ecgwVSX4gBIACNKHCqu0A/exec';

async function fetchFeed(request, page = 1, limit = 50) {
  const res = await request.get(`${API_URL}?action=feed&page=${page}&limit=${limit}`, {
    timeout: 30000, // Apps Script cold-starts can take 3-10s
  });
  return res.json();
}

test.describe('Feed Health (Production API)', () => {
  test.describe.configure({ timeout: 60000 });

  // ══════════════════════════════════════════════════════════
  // FRESHNESS — Feed should not be stale
  // ══════════════════════════════════════════════════════════

  test('most recent item is less than 24 hours old', async ({ request }) => {
    const data = await fetchFeed(request, 1, 1);
    expect(data.status).toBe('ok');
    expect(data.videos.length).toBeGreaterThan(0);

    const newest = data.videos[0];
    const publishedAt = new Date(newest.published_at);
    const hoursAgo = (Date.now() - publishedAt.getTime()) / (1000 * 60 * 60);

    console.log(`Newest item: "${newest.title}" from ${newest.channel_name}`);
    console.log(`Published: ${newest.published_at} (${hoursAgo.toFixed(1)}h ago)`);

    expect(hoursAgo).toBeLessThan(24);
  });

  test('feed has items published within the last 12 hours', async ({ request }) => {
    const data = await fetchFeed(request, 1, 50);
    const now = Date.now();

    const recentItems = data.videos.filter(v => {
      const age = (now - new Date(v.published_at).getTime()) / (1000 * 60 * 60);
      return age < 12;
    });

    console.log(`Items < 12h old: ${recentItems.length} out of ${data.videos.length}`);
    expect(recentItems.length).toBeGreaterThan(0);
  });

  // ══════════════════════════════════════════════════════════
  // ARTICLE PRESENCE — Blog feeds should produce articles
  // ══════════════════════════════════════════════════════════

  test('feed contains at least one article (non-video) item', async ({ request }) => {
    // Fetch a large batch to find articles
    const data = await fetchFeed(request, 1, 100);

    const articles = data.videos.filter(v => v.media_type === 'article');
    const videos = data.videos.filter(v => v.media_type === 'video');

    console.log(`Total: ${data.total}, Videos: ${videos.length}, Articles: ${articles.length}`);

    if (articles.length > 0) {
      console.log('Sample articles:');
      articles.slice(0, 5).forEach(a =>
        console.log(`  📰 ${a.channel_name}: ${a.title}`)
      );
    }

    expect(articles.length).toBeGreaterThan(0);
  });

  test('articles have preview_image or url fields', async ({ request }) => {
    const data = await fetchFeed(request, 1, 200);
    const articles = data.videos.filter(v => v.media_type === 'article');

    // Skip if no articles (the previous test will catch that)
    if (articles.length === 0) {
      test.skip();
      return;
    }

    for (const article of articles) {
      // Every article must have a URL
      expect(article.url).toBeTruthy();
      expect(article.url).toMatch(/^https?:\/\//);

      // Title should not be empty
      expect(article.title).toBeTruthy();
    }

    // At least some articles should have preview images
    const withImages = articles.filter(a => a.preview_image);
    console.log(`Articles with images: ${withImages.length}/${articles.length}`);
    expect(withImages.length).toBeGreaterThan(0);
  });

  // ══════════════════════════════════════════════════════════
  // DATA INTEGRITY — No broken entries
  // ══════════════════════════════════════════════════════════

  test('no items have empty or missing video_id', async ({ request }) => {
    const data = await fetchFeed(request, 1, 50);

    for (const item of data.videos) {
      expect(item.video_id).toBeTruthy();
      expect(typeof item.video_id).toBe('string');
      expect(item.video_id.length).toBeGreaterThan(0);
    }
  });

  test('no items have empty titles', async ({ request }) => {
    const data = await fetchFeed(request, 1, 50);

    for (const item of data.videos) {
      expect(item.title).toBeTruthy();
      expect(item.title.trim().length).toBeGreaterThan(0);
    }
  });

  test('all items have valid published_at dates', async ({ request }) => {
    const data = await fetchFeed(request, 1, 50);

    for (const item of data.videos) {
      const date = new Date(item.published_at);
      expect(date.getTime()).not.toBeNaN();
      // Should not be in the future (allowing 1 hour buffer for timezone drift)
      expect(date.getTime()).toBeLessThan(Date.now() + 3600000);
    }
  });

  test('no duplicate video_ids in the feed', async ({ request }) => {
    const data = await fetchFeed(request, 1, 100);

    const ids = data.videos.map(v => v.video_id);
    const unique = new Set(ids);

    if (ids.length !== unique.size) {
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      console.log('Duplicate IDs found:', [...new Set(dupes)]);
    }

    expect(ids.length).toBe(unique.size);
  });

  test('every item has a valid media_type (video or article)', async ({ request }) => {
    const data = await fetchFeed(request, 1, 50);

    for (const item of data.videos) {
      expect(['video', 'article']).toContain(item.media_type);
    }
  });
});
