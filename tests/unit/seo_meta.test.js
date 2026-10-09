/**
 * SEO / social meta: every public page unfurls with an image, declares its
 * canonical URL, and ships a favicon; robots.txt and sitemap.xml exist and
 * agree with each other. Pure file checks — no DOM — so a renamed asset or a
 * dropped tag fails here, not in a sharing debugger after deploy.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://www.howyouwatch.com';
const OG_IMAGE = `${ORIGIN}/assets/og-image.png`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const exists = (f) => existsSync(path.join(ROOT, f));
const meta = (html, attr, name) => html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`))?.[1];

const PUBLIC = {
  'index.html': `${ORIGIN}/`,
  'privacy.html': `${ORIGIN}/privacy.html`,
  'terms.html': `${ORIGIN}/terms.html`,
};
const ALL_PAGES = [...Object.keys(PUBLIC), '404.html', 'add-channel.html'];

describe('social unfurl', () => {
  for (const [file, url] of Object.entries(PUBLIC)) {
    it(`${file} carries canonical, Open Graph and Twitter tags with the og:image`, () => {
      const html = read(file);
      expect(html).toContain(`<link rel="canonical" href="${url}">`);
      expect(meta(html, 'property', 'og:url')).toBe(url);
      expect(meta(html, 'property', 'og:title')).toBeTruthy();
      expect(meta(html, 'property', 'og:description')).toBeTruthy();
      expect(meta(html, 'property', 'og:image')).toBe(OG_IMAGE);
      expect(meta(html, 'property', 'og:image:width')).toBe('1200');
      expect(meta(html, 'property', 'og:image:height')).toBe('630');
      expect(meta(html, 'name', 'twitter:card')).toBe('summary_large_image');
      expect(meta(html, 'name', 'twitter:image')).toBe(OG_IMAGE);
    });
  }

  it('og-image.png exists and is 1200×630', () => {
    const png = readFileSync(path.join(ROOT, 'assets/og-image.png'));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  });
});

describe('icons', () => {
  for (const file of ALL_PAGES) {
    it(`${file} links the favicon set`, () => {
      const html = read(file);
      expect(html).toContain('<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">');
      expect(html).toContain('<link rel="icon" href="/assets/favicon.ico"');
      expect(html).toContain('<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">');
    });
  }
  it('the linked icon files exist', () => {
    for (const f of ['assets/favicon.svg', 'assets/favicon.ico', 'assets/apple-touch-icon.png']) {
      expect(exists(f), f).toBe(true);
    }
  });
});

describe('crawl directives', () => {
  it('robots.txt allows crawling, hides the admin page, and points at the sitemap', () => {
    const robots = read('robots.txt');
    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots).toMatch(/^Allow: \/$/m);
    expect(robots).toMatch(/^Disallow: \/add-channel\.html$/m);
    expect(robots).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });
  it('sitemap.xml lists exactly the public pages, by their canonical URLs', () => {
    const locs = [...read('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).sort();
    expect(locs).toEqual(Object.values(PUBLIC).sort());
  });
  it('noindex pages stay out of the sitemap and off the index', () => {
    expect(read('404.html')).toContain('<meta name="robots" content="noindex">');
    expect(read('add-channel.html')).toContain('<meta name="robots" content="noindex, nofollow">');
  });
});
