/**
 * index.html's <link rel="modulepreload"> list must be exactly the set of
 * modules reachable from its <script type="module"> entries.
 *
 * Why it matters: the app ships ~30 unbundled ES modules with an import chain
 * 11 deep. Without preloads the browser discovers each level only after the
 * previous one downloads — 11 round trips, 5.6s on Slow 4G before the first
 * card (measured 2026-10-07). A module missing from the list silently brings a
 * round trip back; a stale entry downloads code nothing uses. This test turns
 * both into a failure the moment an import is added or removed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** Relative module specifiers imported by js/<file>, resolved to js-relative paths. */
function importsOf(file) {
  const src = fs.readFileSync(path.join(ROOT, 'js', file), 'utf8');
  const out = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]/g)) {
    out.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1])));
  }
  for (const m of src.matchAll(/(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g)) {
    out.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1])));
  }
  return out;
}

/** Every module reachable from the given js-relative entry files. */
function reachable(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    queue.push(...importsOf(f));
  }
  return seen;
}

const moduleEntries = [...INDEX_HTML.matchAll(/<script[^>]*type="module"[^>]*src="js\/([^"]+)"/g)].map(m => m[1]);
const preloads = [...INDEX_HTML.matchAll(/<link rel="modulepreload" href="js\/([^"]+)">/g)].map(m => m[1]);

describe('index.html module preloads', () => {
  it('has module entry points to preload for', () => {
    expect(moduleEntries).toContain('app.js');
    expect(moduleEntries).toContain('error-reporter.js');
  });

  it('lists exactly the modules reachable from the entry points', () => {
    const expected = [...reachable(moduleEntries)].sort();
    const actual = [...preloads].sort();
    const missing = expected.filter(f => !actual.includes(f));
    const stale = actual.filter(f => !expected.includes(f));
    expect(missing, `reachable modules with no <link rel="modulepreload">: ${missing.join(', ')}`).toEqual([]);
    expect(stale, `preloaded modules nothing imports: ${stale.join(', ')}`).toEqual([]);
    expect(new Set(actual).size, 'duplicate preload entries').toBe(actual.length);
  });

  it('keeps the entry points themselves in the list (the first wave includes them)', () => {
    for (const entry of moduleEntries) expect(preloads).toContain(entry);
  });

  it('defers the analytics script so it does not block the parser', () => {
    const tag = INDEX_HTML.match(/<script[^>]*src="js\/analytics\.js"[^>]*>/)[0];
    expect(tag).toMatch(/\sdefer[\s>]/);
    expect(tag).not.toMatch(/type="module"/); // it is a classic script and must stay one (document-order run before modules)
  });
});
