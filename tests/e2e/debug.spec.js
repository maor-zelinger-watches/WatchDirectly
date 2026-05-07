import { test, expect } from '@playwright/test';

test('debug render', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.route('https://script.google.com/macros/s/*/exec?action=init', async route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', api_secret: 'mock-secret' }) }));
  await page.route('https://script.google.com/macros/s/*/exec?action=feed*', async route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', total: 2, page: 1, videos: [{ video_id: 'vid123', media_type: 'video', channel_name: 'Test Tube', title: 'A Great Watch Video', url: 'https://youtube.com/watch?v=vid123', published_at: new Date(Date.now() - 100000).toISOString(), tier: 'T1', category: 'Review', comment_count: 5 }, { video_id: 'art456', media_type: 'article', channel_name: 'Worn & Wound', title: 'An In-Depth Article', url: 'https://wornandwound.com/article1', preview_image: 'https://wornandwound.com/images/1.jpg', published_at: new Date(Date.now() - 200000).toISOString(), tier: 'T1', category: 'Editorial', comment_count: 2 }] }) }));
  await page.route('https://script.google.com/macros/s/*/exec?action=comments*', async route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', comments: [] }) }));

  await page.goto('/');
  await expect(page.locator('#feed-skeleton')).toBeHidden({ timeout: 5000 });
  const html = await page.locator('#feed-container').innerHTML();
  console.log(html);
});
