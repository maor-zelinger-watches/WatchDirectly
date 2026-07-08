/**
 * E2E tests for the content-type filter chips (mocked API)
 *
 * The chips are pure UI visibility filters: All / Videos / Articles / Shorts.
 * Cards are never removed or re-rendered — deselected types are hidden with
 * a container CSS class, so switching filters is instant and can't crash a
 * large catalog. Multi-select rules: "All" is exclusive, picking a type
 * clears "All", picking every type collapses back to "All", and deselecting
 * the last type falls back to "All".
 *
 * Top-up: when the filtered Latest feed has fewer than
 * CONFIG.TYPE_FILTER_MIN_CARDS (20) items of the selected types, more pages
 * are pulled automatically until the threshold is met or the catalog ends.
 */

import { test, expect } from '@playwright/test';

const now = Date.now();

const MOCK_FEED = {
  status: 'ok',
  videos: [
    { video_id: 'vid00000001', media_type: 'video', channel_name: 'Teddy Baldassarre', title: 'Tudor Black Bay Review', url: 'https://www.youtube.com/watch?v=vid00000001', published_at: new Date(now - 1 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0 },
    { video_id: 'vid00000002', media_type: 'video', channel_name: 'Jenni Elle', title: 'Omega Deep Dive', url: 'https://www.youtube.com/watch?v=vid00000002', published_at: new Date(now - 2 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0 },
    { video_id: 'YXJ0aWNsZTAx', media_type: 'article', channel_name: 'Hodinkee', title: 'The Rise of Microbrands', url: 'https://www.hodinkee.com/articles/microbrands', preview_image: 'https://cdn.hodinkee.com/x.jpg', published_at: new Date(now - 3 * 3600 * 1000).toISOString(), category: 'Editorial', comment_count: 0 },
    { video_id: 'shrt0000001', media_type: 'video', channel_name: 'Nico Leonard', title: 'Quick Short Take', url: 'https://www.youtube.com/shorts/shrt0000001', published_at: new Date(now - 4 * 3600 * 1000).toISOString(), category: 'Reviews', comment_count: 0 },
  ],
  total: 4,
  page: 1,
};

const chip = (page, label) => page.locator('#category-chips .chip', { hasText: new RegExp(`^${label}$`) });
const visibleCards = (page) => page.locator('.media-card:visible');
const allCards = (page) => page.locator('.media-card');

// A saved [] selection means the user previously chose "All". Seeding it gives
// the interaction tests a stable "All" baseline that's independent of the
// default (Videos + Articles) — the default itself is covered separately below.
const seedAllBaseline = (page) =>
  page.addInitScript(() => window.localStorage.setItem('wd_filter_types', '[]'));

function mockRoutes(page, feedBody) {
  return page.route('**/macros/**', async (route) => {
    const url = route.request().url();
    if (url.includes('action=feed')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(feedBody(url)) });
    }
    if (url.includes('action=commentsBatch')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', byVideo: {} }) });
    }
    if (url.includes('action=comments')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', comments: [] }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok' }) });
  });
}

test.describe('Content-type filter chips (UI visibility)', () => {
  test.beforeEach(async ({ page }) => {
    await seedAllBaseline(page);
    await mockRoutes(page, () => MOCK_FEED);
    await page.goto('/');
    await expect(allCards(page)).toHaveCount(4);
  });

  test('renders the four content-type chips, All active for a saved "All" selection', async ({ page }) => {
    await expect(chip(page, 'All')).toBeVisible();
    await expect(chip(page, 'Videos')).toBeVisible();
    await expect(chip(page, 'Articles')).toBeVisible();
    await expect(chip(page, 'Shorts')).toBeVisible();

    await expect(chip(page, 'All')).toHaveClass(/chip--active/);
    await expect(page.locator('.chip--active')).toHaveCount(1);
  });

  test('filtering hides cards without removing them from the DOM', async ({ page }) => {
    await chip(page, 'Videos').click();

    // Only the two long-form videos are visible…
    await expect(visibleCards(page)).toHaveCount(2);
    await expect(chip(page, 'Videos')).toHaveClass(/chip--active/);
    await expect(chip(page, 'All')).not.toHaveClass(/chip--active/);

    // …but every card is still in the DOM — nothing was re-rendered.
    await expect(allCards(page)).toHaveCount(4);
  });

  test('Articles shows only the article', async ({ page }) => {
    await chip(page, 'Articles').click();
    await expect(visibleCards(page)).toHaveCount(1);
    await expect(page.locator('.media-card:visible .media-card__title')).toContainText('Microbrands');
  });

  test('Shorts shows only the short', async ({ page }) => {
    await chip(page, 'Shorts').click();
    await expect(visibleCards(page)).toHaveCount(1);
    await expect(page.locator('.media-card--short:visible')).toHaveCount(1);
  });

  test('multiple types union together (Articles + Shorts)', async ({ page }) => {
    await chip(page, 'Articles').click();
    await chip(page, 'Shorts').click();

    await expect(visibleCards(page)).toHaveCount(2);
    await expect(chip(page, 'Articles')).toHaveClass(/chip--active/);
    await expect(chip(page, 'Shorts')).toHaveClass(/chip--active/);
    await expect(chip(page, 'All')).not.toHaveClass(/chip--active/);
  });

  test('selecting all three types collapses back to All', async ({ page }) => {
    await chip(page, 'Videos').click();
    await chip(page, 'Articles').click();
    await chip(page, 'Shorts').click();

    await expect(chip(page, 'All')).toHaveClass(/chip--active/);
    await expect(page.locator('.chip--active')).toHaveCount(1);
    await expect(visibleCards(page)).toHaveCount(4);
  });

  test('deselecting the last active type falls back to All', async ({ page }) => {
    await chip(page, 'Videos').click();
    await expect(visibleCards(page)).toHaveCount(2);

    await chip(page, 'Videos').click(); // toggle it back off

    await expect(chip(page, 'All')).toHaveClass(/chip--active/);
    await expect(page.locator('.chip--active')).toHaveCount(1);
    await expect(visibleCards(page)).toHaveCount(4);
  });

  test('clicking All clears an active type selection', async ({ page }) => {
    await chip(page, 'Videos').click();
    await expect(visibleCards(page)).toHaveCount(2);

    await chip(page, 'All').click();

    await expect(chip(page, 'All')).toHaveClass(/chip--active/);
    await expect(page.locator('.chip--active')).toHaveCount(1);
    await expect(visibleCards(page)).toHaveCount(4);
  });

  test('rapid filter switching never crashes or blanks the feed', async ({ page }) => {
    // The old implementation re-rendered the whole catalog per click and froze.
    // As a pure CSS filter, hammering the chips must stay responsive.
    for (let i = 0; i < 3; i++) {
      await chip(page, 'Videos').click();
      await chip(page, 'Articles').click();
      await chip(page, 'Shorts').click();
      await chip(page, 'All').click();
    }

    await expect(visibleCards(page)).toHaveCount(4);
    await expect(allCards(page)).toHaveCount(4);
  });

  test('a type filter combines with the search query (CSS still applies)', async ({ page }) => {
    // "microbrands" matches only the article; with Videos selected the
    // rendered search result is hidden by the type filter.
    await chip(page, 'Videos').click();
    await page.fill('#search-input', 'microbrands');

    await expect(allCards(page)).toHaveCount(1);
    await expect(visibleCards(page)).toHaveCount(0);

    // Switching the type back to All reveals the match instantly.
    await chip(page, 'All').click();
    await expect(visibleCards(page)).toHaveCount(1);
  });

  test('the type filter persists across tab switches', async ({ page }) => {
    await chip(page, 'Videos').click();
    await expect(visibleCards(page)).toHaveCount(2);

    await page.locator('.feed-tab', { hasText: 'Top This Week' }).click();
    await page.locator('.feed-tab', { hasText: 'Latest' }).click();

    await expect(chip(page, 'Videos')).toHaveClass(/chip--active/);
    await expect(visibleCards(page)).toHaveCount(2);
    await expect(allCards(page)).toHaveCount(4);
  });
});

test.describe('Content-type filter default & persistence', () => {
  test('a first-time visitor defaults to Videos + Articles (Shorts hidden)', async ({ page }) => {
    // Fresh context = empty localStorage; no init script (which would also
    // re-run on reload and wipe the saved selection the next tests rely on).
    await mockRoutes(page, () => MOCK_FEED);
    await page.goto('/');
    await expect(allCards(page)).toHaveCount(4);

    await expect(chip(page, 'Videos')).toHaveClass(/chip--active/);
    await expect(chip(page, 'Articles')).toHaveClass(/chip--active/);
    await expect(chip(page, 'All')).not.toHaveClass(/chip--active/);
    await expect(chip(page, 'Shorts')).not.toHaveClass(/chip--active/);

    // The two videos + the article are visible; the short is hidden.
    await expect(visibleCards(page)).toHaveCount(3);
    await expect(page.locator('.media-card--short:visible')).toHaveCount(0);
  });

  test('the selection persists across a reload', async ({ page }) => {
    await mockRoutes(page, () => MOCK_FEED);
    await page.goto('/');
    await expect(allCards(page)).toHaveCount(4);

    // Narrow to just Videos, then reload — the choice must come back.
    await chip(page, 'Articles').click(); // drop articles from the default
    await expect(chip(page, 'Videos')).toHaveClass(/chip--active/);
    await expect(chip(page, 'Articles')).not.toHaveClass(/chip--active/);
    await expect(visibleCards(page)).toHaveCount(2);

    await page.reload();
    await expect(allCards(page)).toHaveCount(4);

    await expect(chip(page, 'Videos')).toHaveClass(/chip--active/);
    await expect(chip(page, 'Articles')).not.toHaveClass(/chip--active/);
    await expect(chip(page, 'All')).not.toHaveClass(/chip--active/);
    await expect(visibleCards(page)).toHaveCount(2);
  });

  test('choosing All persists as All across a reload', async ({ page }) => {
    await mockRoutes(page, () => MOCK_FEED);
    await page.goto('/');
    await expect(allCards(page)).toHaveCount(4);

    await chip(page, 'All').click();
    await expect(chip(page, 'All')).toHaveClass(/chip--active/);
    await expect(visibleCards(page)).toHaveCount(4);

    await page.reload();
    await expect(allCards(page)).toHaveCount(4);

    await expect(chip(page, 'All')).toHaveClass(/chip--active/);
    await expect(page.locator('.chip--active')).toHaveCount(1);
    await expect(visibleCards(page)).toHaveCount(4);
  });
});

test.describe('Content-type filter top-up (pull more when under 20)', () => {
  function pagedCatalog(items) {
    return (url) => {
      const u = new URL(url);
      const pg = parseInt(u.searchParams.get('page')) || 1;
      const limit = parseInt(u.searchParams.get('limit')) || 10;
      const start = (pg - 1) * limit;
      return { status: 'ok', total: items.length, page: pg, videos: items.slice(start, start + limit) };
    };
  }

  function mockItem(i, type) {
    const id = type === 'article' ? `article_id_${String(i).padStart(4, '0')}` : `vid_${String(i).padStart(4, '0')}`;
    return {
      video_id: id,
      media_type: type === 'article' ? 'article' : 'video',
      channel_name: 'Topup Channel',
      title: `Item ${i} (${type})`,
      url: type === 'article' ? `https://example.com/a/${i}`
        : type === 'short' ? `https://www.youtube.com/shorts/${id}`
        : `https://www.youtube.com/watch?v=${id}`,
      published_at: new Date(now - (i + 1) * 60000).toISOString(),
      category: 'Reviews',
      comment_count: 0,
    };
  }

  test('a sparse type keeps pulling pages until the catalog is exhausted', async ({ page }) => {
    // 30 items over 3 pages, 2 articles per page — 6 articles total, well
    // under the 20-item threshold, so filtering to Articles must pull
    // everything the backend has.
    const items = Array.from({ length: 30 }, (_, i) =>
      mockItem(i, i % 10 === 2 || i % 10 === 7 ? 'article' : 'video'));

    await seedAllBaseline(page);
    await mockRoutes(page, pagedCatalog(items));
    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(10);

    await page.locator('#category-chips .chip', { hasText: /^Articles$/ }).click();

    // Top-up pulls pages 2 and 3; all 30 cards land, 6 visible.
    await expect(page.locator('.media-card')).toHaveCount(30, { timeout: 15000 });
    await expect(page.locator('.media-card:visible')).toHaveCount(6);
  });

  test('top-up stops once 20 items of the selected type are loaded', async ({ page }) => {
    // 30 videos over 3 pages. Filtering to Videos with 10 loaded pulls one
    // more page to reach the 20 threshold — page 3 must NOT be rendered.
    const items = Array.from({ length: 30 }, (_, i) => mockItem(i, 'video'));

    await seedAllBaseline(page);
    await mockRoutes(page, pagedCatalog(items));
    await page.goto('/');
    await expect(page.locator('.media-card')).toHaveCount(10);

    await page.locator('#category-chips .chip', { hasText: /^Videos$/ }).click();

    await expect(page.locator('.media-card')).toHaveCount(20, { timeout: 15000 });

    // Give a stray extra load a chance to land — the count must hold at 20.
    await page.waitForTimeout(1200);
    await expect(page.locator('.media-card')).toHaveCount(20);
  });
});
