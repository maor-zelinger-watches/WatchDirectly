/**
 * Article preview images: sized variants for hosts behind Cloudflare Image
 * Resizing, and eager/high-priority loading for the first cards of a fresh
 * paint (the LCP candidate). See the "article preview images" block in
 * js/feed.js and FIRST_PAINT_PRIORITY_CARDS in js/cards.js.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  previewImageSources, createMediaCard, PREVIEW_WIDTHS, PREVIEW_SIZES,
} from '../../js/feed.js';

// cards.js -> lazy-iframe.js builds an IntersectionObserver at module load —
// stub it before the dynamic import (same dance as cards.test.js).
class FakeIO { constructor() {} observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('IntersectionObserver', FakeIO);
const { renderList, FIRST_PAINT_PRIORITY_CARDS } = await import('../../js/cards.js');

const CF_URL = 'https://www.fratellowatches.com/cdn-cgi/image/anim=false/wp-content/uploads/2026/10/Ebel.jpg';
const PLAIN_URL = 'https://monochrome-watches.com/app/uploads/2026/10/HMoser-600x237.jpg';

function article(id, preview_image) {
  return {
    video_id: id, media_type: 'article', title: `Article ${id}`, channel_name: 'Fratello',
    url: 'https://www.fratellowatches.com/x/', published_at: '2026-10-07T09:00:00.000Z',
    preview_image, comment_count: 0, vote_count: 0,
  };
}

describe('previewImageSources', () => {
  it('returns null for no URL and a plain src for hosts without resizing', () => {
    expect(previewImageSources('')).toBeNull();
    expect(previewImageSources(null)).toBeNull();
    expect(previewImageSources(PLAIN_URL)).toEqual({ src: PLAIN_URL, srcset: '' });
  });

  it('builds sized, format=auto variants for a Cloudflare image-resizing URL', () => {
    const { src, srcset } = previewImageSources(CF_URL);
    const prefix = 'https://www.fratellowatches.com/cdn-cgi/image/';
    const rest = '/wp-content/uploads/2026/10/Ebel.jpg';
    expect(src).toBe(`${prefix}anim=false,width=${PREVIEW_WIDTHS.at(-1)},fit=scale-down,format=auto${rest}`);
    expect(srcset).toBe(PREVIEW_WIDTHS.map(w => `${prefix}anim=false,width=${w},fit=scale-down,format=auto${rest} ${w}w`).join(', '));
    expect(PREVIEW_WIDTHS).toEqual([640, 1280]);
    expect(PREVIEW_SIZES).toBe('(max-width: 760px) 100vw, 760px');
  });

  it('replaces sizing options the site already set and keeps the others', () => {
    const url = 'https://example.com/cdn-cgi/image/width=2000,quality=80,fit=cover,format=webp,anim=false/img/a.jpg';
    const { src } = previewImageSources(url);
    expect(src).toBe('https://example.com/cdn-cgi/image/quality=80,anim=false,width=1280,fit=scale-down,format=auto/img/a.jpg');
  });

  it('handles an empty options segment', () => {
    const { src } = previewImageSources('https://example.com/cdn-cgi/image//img/a.jpg');
    expect(src).toBe('https://example.com/cdn-cgi/image/width=1280,fit=scale-down,format=auto/img/a.jpg');
  });

  it('leaves non-https and non-cdn-cgi paths untouched', () => {
    const odd = 'https://example.com/images/cdn-cgi/image/not-really/a.jpg';
    expect(previewImageSources(odd)).toEqual({ src: odd, srcset: '' });
  });
});

describe('createMediaCard preview image attributes', () => {
  it('lazy-loads by default, with srcset/sizes for resizable hosts', () => {
    const html = createMediaCard(article('a1', CF_URL));
    const img = html.match(/<img[^>]*class="article-card__img"[^>]*>/)[0];
    expect(img).toContain('loading="lazy"');
    expect(img).not.toContain('fetchpriority');
    expect(img).toContain('srcset="');
    expect(img).toContain(`sizes="${PREVIEW_SIZES}"`);
    expect(img).toContain('width=640,fit=scale-down,format=auto');
    expect(img).toContain('width=1280,fit=scale-down,format=auto');
  });

  it('no srcset for a host without resizing', () => {
    const img = createMediaCard(article('a2', PLAIN_URL)).match(/<img[^>]*class="article-card__img"[^>]*>/)[0];
    expect(img).toContain(`src="${PLAIN_URL}"`);
    expect(img).not.toContain('srcset');
  });

  it('priority cards load eagerly at high fetch priority', () => {
    const img = createMediaCard(article('a3', CF_URL), { priority: true }).match(/<img[^>]*class="article-card__img"[^>]*>/)[0];
    expect(img).toContain('loading="eager"');
    expect(img).toContain('fetchpriority="high"');
    expect(img).not.toContain('loading="lazy"');
  });

  it('a video card is unaffected by the priority option', () => {
    const video = { video_id: 'dQw4w9WgXcQ', media_type: 'video', title: 'V', channel_name: 'C', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', published_at: '2026-10-07T09:00:00.000Z' };
    expect(createMediaCard(video, { priority: true })).toBe(createMediaCard(video));
  });
});

describe('renderList first-paint priority', () => {
  let container;
  beforeEach(() => {
    document.body.innerHTML = '<div id="feed-container"></div>';
    container = document.getElementById('feed-container');
  });

  it(`gives the first ${FIRST_PAINT_PRIORITY_CARDS} cards of an empty container eager images, the rest lazy`, () => {
    expect(FIRST_PAINT_PRIORITY_CARDS).toBe(2);
    const items = Array.from({ length: 5 }, (_, i) => article(`r${i}`, CF_URL));
    renderList(container, items);
    const loadings = [...container.querySelectorAll('.article-card__img')].map(img => img.getAttribute('loading'));
    expect(loadings).toEqual(['eager', 'eager', 'lazy', 'lazy', 'lazy']);
    const priorities = [...container.querySelectorAll('.article-card__img')].map(img => img.getAttribute('fetchpriority'));
    expect(priorities).toEqual(['high', 'high', null, null, null]);
  });

  it('appending to a populated container stays lazy throughout', () => {
    renderList(container, [article('p0', CF_URL)]);
    renderList(container, [article('p1', CF_URL), article('p2', CF_URL)]);
    const loadings = [...container.querySelectorAll('.article-card__img')].map(img => img.getAttribute('loading'));
    expect(loadings).toEqual(['eager', 'lazy', 'lazy']);
  });
});
