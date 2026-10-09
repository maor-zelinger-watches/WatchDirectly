/**
 * Poppins is self-hosted: no page may reach fonts.googleapis.com or
 * fonts.gstatic.com, every @font-face in css/style.css must point at a file
 * that exists under assets/fonts/, and the weights the design tokens use must
 * all be covered (a missing weight silently falls back to faux-bold or the
 * nearest face — no error, just a worse render).
 *
 * Why it matters: the Google Fonts stylesheet was a render-blocking
 * cross-origin request before first paint (~850ms cold, measured 2026-10-09).
 * Someone re-adding the <link> "to pick up a new weight" would bring that
 * back; this test turns it into a failure.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PAGES = ['index.html', '404.html', 'add-channel.html', 'privacy.html', 'terms.html'];
const CSS = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');

describe('self-hosted fonts', () => {
  it.each(PAGES)('%s does not load fonts from Google (markup or CSP)', (page) => {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    expect(html).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    expect(csp).toMatch(/font-src 'self'(;|$)/);
  });

  it('every @font-face src file exists under assets/fonts/', () => {
    const srcs = [...CSS.matchAll(/src:\s*url\('\.\.\/(assets\/fonts\/[^']+)'\)/g)].map((m) => m[1]);
    expect(srcs.length).toBeGreaterThan(0);
    for (const rel of srcs) expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(true);
  });

  it('covers every weight the design tokens use, and only Poppins', () => {
    const used = new Set([...CSS.matchAll(/--fw-[a-z]+:\s*(\d+)/g)].map((m) => m[1]));
    const faces = [...CSS.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);
    const declared = new Set(faces.map((f) => f.match(/font-weight:\s*(\d+)/)[1]));
    expect(used.size).toBeGreaterThan(0);
    for (const w of used) expect(declared, `weight ${w}`).toContain(w);
    for (const f of faces) {
      expect(f).toMatch(/font-family:\s*'Poppins'/);
      expect(f).toMatch(/font-display:\s*swap/);
    }
  });

  it('index.html preloads only font files that @font-face actually declares', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const preloads = [...html.matchAll(/<link rel="preload" href="(assets\/fonts\/[^"]+)" as="font"[^>]*crossorigin>/g)].map((m) => m[1]);
    expect(preloads.length).toBeGreaterThan(0);
    for (const rel of preloads) expect(CSS).toContain(`url('../${rel}')`);
  });
});
