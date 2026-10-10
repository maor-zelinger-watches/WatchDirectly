/**
 * Installable-app (PWA) wiring: the manifest, the service worker's precache
 * list, and the HTML that links them.
 *
 * The parts live in four files that must agree with each other by hand (no
 * build step generates any of them): index.html's modulepreload list, the
 * @font-face files in css/style.css, sw.js's PRECACHE_URLS, and the manifest's
 * icons. A module missing from the precache list is a shell that breaks
 * offline on its first import; a listed file that no longer exists fails the
 * whole install (cache.addAll semantics — one 404 and nothing is cached).
 * This test turns each of those into a failure at `npm test` time.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRECACHE_URLS } from '../../sw.js';
import { CONFIG } from '../../js/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const INDEX_HTML = read('index.html');
const SW_SRC = read('sw.js');
const MANIFEST = JSON.parse(read('manifest.webmanifest'));

/** PNG width/height from the IHDR chunk (bytes 16–23). */
function pngSize(file) {
  const buf = fs.readFileSync(path.join(ROOT, file));
  expect(buf.subarray(1, 4).toString('ascii'), `${file} is not a PNG`).toBe('PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** '/' → index.html, '/js/app.js' → js/app.js */
const onDisk = (url) => (url === '/' ? 'index.html' : url.replace(/^\//, ''));

describe('manifest.webmanifest', () => {
  it('describes a standalone app rooted at /', () => {
    expect(MANIFEST.name).toBe('How You Watch');
    expect(MANIFEST.short_name.length).toBeLessThanOrEqual(15);
    expect(MANIFEST.start_url).toBe('/');
    expect(MANIFEST.scope).toBe('/');
    expect(MANIFEST.id).toBe('/');
    expect(MANIFEST.display).toBe('standalone');
    expect(MANIFEST.theme_color).toBe('#000000');
    expect(MANIFEST.background_color).toBe('#000000');
  });

  it('ships 192 and 512 "any" icons plus a 512 maskable one, each the size it claims', () => {
    const sizes = (purpose) => MANIFEST.icons.filter((i) => i.purpose === purpose).map((i) => i.sizes);
    expect(sizes('any')).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(sizes('maskable')).toContain('512x512');
    for (const icon of MANIFEST.icons) {
      expect(icon.type).toBe('image/png');
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(pngSize(onDisk(icon.src)), icon.src).toEqual({ width: w, height: h });
    }
  });

  it('is linked from every page, and index.html carries the iOS home-screen metas', () => {
    for (const file of ['index.html', 'privacy.html', 'terms.html', 'add-channel.html', '404.html']) {
      expect(read(file), file).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest">/);
    }
    expect(INDEX_HTML).toMatch(/<meta name="apple-mobile-web-app-capable" content="yes">/);
    expect(INDEX_HTML).toMatch(/<meta name="mobile-web-app-capable" content="yes">/);
    expect(INDEX_HTML).toMatch(/<meta name="apple-mobile-web-app-title" content="How You Watch">/);
    expect(INDEX_HTML).toMatch(/<meta name="theme-color" content="#000000">/);
  });
});

describe('sw.js precache list', () => {
  it('names its cache after CONFIG.APP_VERSION imported from js/config.js', () => {
    expect(SW_SRC).toMatch(/import \{ CONFIG \} from '\.\/js\/config\.js'/);
    expect(SW_SRC).toMatch(/CONFIG\.APP_VERSION/);
    expect(typeof CONFIG.APP_VERSION).toBe('string');
  });

  it('only lists files that exist (one missing file would fail the whole install)', () => {
    const missing = PRECACHE_URLS.filter((u) => !fs.existsSync(path.join(ROOT, onDisk(u))));
    expect(missing).toEqual([]);
    expect(new Set(PRECACHE_URLS).size, 'duplicate precache entries').toBe(PRECACHE_URLS.length);
    for (const u of PRECACHE_URLS) expect(u, 'precache URLs are root-relative').toMatch(/^\//);
  });

  it('covers the shell: /, the manifest, the stylesheet, every preloaded module, and js/pwa.js', () => {
    const preloads = [...INDEX_HTML.matchAll(/<link rel="modulepreload" href="(js\/[^"]+)">/g)].map((m) => `/${m[1]}`);
    expect(preloads.length).toBeGreaterThan(20);
    const classic = [...INDEX_HTML.matchAll(/<script src="(js\/[^"]+)"/g)].map((m) => `/${m[1]}`);
    const expected = ['/', '/manifest.webmanifest', '/css/style.css', '/js/pwa.js', ...preloads, ...classic];
    const absent = expected.filter((u) => !PRECACHE_URLS.includes(u));
    expect(absent, 'shell files missing from PRECACHE_URLS').toEqual([]);
  });

  it('covers every self-hosted font the stylesheet declares', () => {
    const css = read('css/style.css');
    const fonts = [...css.matchAll(/url\((["']?)(?:\.\.\/)?(assets\/fonts\/[^"')]+)\1\)/g)].map((m) => `/${m[2]}`);
    expect(fonts.length).toBeGreaterThan(0);
    const absent = fonts.filter((u) => !PRECACHE_URLS.includes(u));
    expect(absent, 'fonts missing from PRECACHE_URLS').toEqual([]);
  });

  it('includes every manifest icon and the favicons', () => {
    for (const icon of MANIFEST.icons) expect(PRECACHE_URLS).toContain(icon.src);
    expect(PRECACHE_URLS).toContain('/assets/favicon.svg');
    expect(PRECACHE_URLS).toContain('/assets/apple-touch-icon.png');
  });
});

describe('registration', () => {
  it('app.js loads js/pwa.js dynamically after load, so it stays out of the preload wave', () => {
    const app = read('js/app.js');
    expect(app).toMatch(/addEventListener\('load'[\s\S]{0,200}import\('\.\/pwa\.js'\)/);
    expect(app).not.toMatch(/^\s*import[^'"]*from\s*['"]\.\/pwa\.js['"]/m);
    expect(INDEX_HTML).not.toMatch(/modulepreload" href="js\/pwa\.js"/);
  });

  it('js/pwa.js registers /sw.js as a module worker that bypasses the HTTP cache on update checks', () => {
    const pwa = read('js/pwa.js');
    expect(pwa).toMatch(/register\('\/sw\.js',\s*\{[^}]*type: 'module'[^}]*updateViaCache: 'none'/);
  });

  it('index.html has the hidden footer "Install app" link js/pwa.js reveals', () => {
    expect(INDEX_HTML).toMatch(/<a [^>]*id="install-app"[^>]*hidden>/);
  });

  it('the shared Playwright config blocks service workers so specs keep their route mocks', () => {
    expect(read('playwright.config.js')).toMatch(/serviceWorkers:\s*'block'/);
  });
});
