/**
 * Summarizes compare.perf-live.spec.js runs into a before/after table.
 *
 *   node tests/perf-live/summarize.mjs main-chromium.json branch-chromium.json …
 *
 * Each argument is a Playwright JSON report (test-results/perf-live/results.json
 * copied aside after a run). Prints medians per build × browser.
 */

import fs from 'node:fs';

const rows = [];
for (const file of process.argv.slice(2)) {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const walk = (suite) => {
    for (const s of suite.suites || []) walk(s);
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        for (const r of t.results || []) {
          for (const a of r.attachments || []) {
            if (a.name === 'compare' && a.body) rows.push(JSON.parse(Buffer.from(a.body, 'base64').toString()));
          }
        }
      }
    }
  };
  for (const s of report.suites || []) walk(s);
}

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const groups = new Map();
for (const r of rows) {
  const k = `${r.browser} · ${r.build}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}

const metrics = [
  ['runs', (g) => g.length],
  ['backend feed latency (ms, median)', (g) => median(g.map((r) => r.backendFeedLatencyMs))],
  ['backend retries (total: cold / index / search)', (g) => ['coldRetries', 'indexBuildRetries', 'searchRetries']
    .map((k) => g.reduce((n, r) => n + (r[k] || 0), 0)).join(' / ')],
  ['cold first card (ms)', (g) => median(g.map((r) => r.coldFirstCardMs))],
  ['index build, cold (ms)', (g) => median(g.map((r) => r.indexBuildMs))],
  ['index rows built (median)', (g) => median(g.map((r) => r.indexRows))],
  ['index rows persisted (median)', (g) => median(g.map((r) => r.indexPersistedRows))],
  ['index persisted', (g) => `${g.filter((r) => r.indexPersisted).length}/${g.length} (${[...new Set(g.map((r) => r.indexStoredIn))].join(', ')})`],
  ['localStorage used (chars)', (g) => median(g.map((r) => r.localStorageChars))],
  ['warm feed first card (ms)', (g) => median(g.map((r) => r.warmFeedFirstCardMs))],
  ['warm feed long tasks (ms)', (g) => median(g.map((r) => r.warmFeedBlocking && r.warmFeedBlocking.totalMs))],
  ['returning search → archived hit (ms)', (g) => median(g.map((r) => r.returningSearchMs))],
  ['returning index requests', (g) => median(g.map((r) => r.returningIndexRequests))],
  ['returning search long tasks (ms)', (g) => median(g.map((r) => r.returningSearchBlocking && r.returningSearchBlocking.totalMs))],
  ['returning search longest task (ms)', (g) => median(g.map((r) => r.returningSearchBlocking && r.returningSearchBlocking.maxMs))],
];

const keys = [...groups.keys()].sort();
const header = ['metric', ...keys];
const table = [header, header.map(() => '---'), ...metrics.map(([name, fn]) => [name, ...keys.map((k) => String(fn(groups.get(k)) ?? '—'))])];
console.log(table.map((r) => `| ${r.join(' | ')} |`).join('\n'));
