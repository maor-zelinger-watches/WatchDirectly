#!/usr/bin/env node
/**
 * validate-release.js — pre-ship guard for WatchDirectly.
 *
 * WatchDirectly ships three independently-versioned components:
 *
 *   Frontend  APP_VERSION in js/config.js        → published by `git push` (GitHub Pages)
 *   Backend   VERSION     in apps-script/Code.gs  → deployed by the post-commit clasp hook
 *   Repo      version     in package.json         → rides along in the commit (tooling)
 *
 * Before you commit (which deploys the backend) or push (which publishes the
 * frontend), this checks — deterministically — that every component you're
 * about to ship carries a proper version bump AND a dated CHANGELOG description.
 * It compares your working tree against what's live (origin/main), so it can
 * tell "you changed this but forgot to bump it" apart from "already bumped,
 * good to go".
 *
 * Why the components differ in strictness:
 *   - Frontend / Backend actually go live to users. Shipping them unversioned
 *     or undocumented is a real defect, so those are HARD failures (exit 1).
 *   - tests/** ride along with the feature they cover (see the project's own
 *     history — a frontend feature commit routinely edits tests without a repo
 *     bump), so test changes never demand a bump.
 *   - Other tooling (scripts/, package.json, config) is a soft WARN by default:
 *     it usually rides along too, but sometimes deserves its own repo bump.
 *     Pass --strict-repo to make that a hard failure as well.
 *
 * Usage:
 *   node scripts/validate-release.js            # human-readable, exit 1 on failure
 *   node scripts/validate-release.js --json     # machine-readable summary
 *   node scripts/validate-release.js --strict-repo
 *   RELEASE_BASE=origin/main node scripts/validate-release.js   # override the "live" ref
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = new Set(process.argv.slice(2));
const JSON_OUT = argv.has('--json');
const STRICT_REPO = argv.has('--strict-repo');
const BASE = process.env.RELEASE_BASE || 'origin/main';

function run(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

const ROOT = run('git rev-parse --show-toplevel', process.cwd());
const git = (cmd) => run(cmd, ROOT);

// Best-effort refresh so "live" isn't stale. Never fatal — offline is fine,
// we just compare against whatever origin/main we already have.
try {
  execSync('git fetch origin main --quiet', { cwd: ROOT, stdio: 'ignore', timeout: 15000 });
} catch { /* offline or no remote — carry on with the local ref */ }

const TODAY = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

// ── Component definitions ────────────────────────────────────────────────────
const COMPONENTS = {
  Frontend: { versionFile: 'js/config.js',        re: /APP_VERSION:\s*'([^']+)'/, heading: 'Frontend', block: true },
  Backend:  { versionFile: 'apps-script/Code.gs',  re: /const VERSION = '([^']+)'/, heading: 'Backend',  block: true },
  Repo:     { versionFile: 'package.json',         re: /"version":\s*"([^"]+)"/,   heading: 'Repo',     block: STRICT_REPO },
};

// Which component owns a changed path? 'RideAlong' = supporting files that never
// require a bump of their own; null = ignored entirely.
function classify(path) {
  if (path.startsWith('apps-script/')) return 'Backend';
  if (path.endsWith('.html') || path === 'creators.json'
      || path.startsWith('css/') || path.startsWith('js/')) return 'Frontend';
  if (path.startsWith('tests/')) return 'RideAlong';
  if (path === 'CHANGELOG.md') return null; // the release notes themselves
  return 'Repo';
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function readWorkTree(rel) {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}
function readAtBase(rel) {
  try { return git(`git show ${BASE}:${rel}`); } catch { return null; }
}
function parseVersion(text, re) {
  const m = text && text.match(re);
  return m ? m[1] : null;
}
// Numeric compare on MAJOR.MINOR.PATCH; ignores any prerelease suffix.
function cmpSemver(a, b) {
  const parts = (v) => String(v).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function changedFiles() {
  const set = new Set();
  let hasBase = true;
  try { git(`git rev-parse --verify --quiet ${BASE}^{commit}`); }
  catch { hasBase = false; }

  if (hasBase) {
    for (const f of git(`git diff --name-only ${BASE}`).split('\n')) if (f) set.add(f);
  } else {
    // No base ref (fresh repo / detached) — treat every tracked file as "new".
    for (const f of git('git ls-files').split('\n')) if (f) set.add(f);
  }
  for (const f of git('git ls-files --others --exclude-standard').split('\n')) if (f) set.add(f);
  return { files: [...set], hasBase };
}

// Locate "### <version> — <date>" under the "## <heading>" section and report
// whether it exists, whether it's dated, and whether it has a real description.
function changelogEntry(heading, version) {
  const text = readWorkTree('CHANGELOG.md') || '';
  const lines = text.split('\n');

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === `## ${heading}`) { start = i + 1; break; }
  }
  if (start === -1) return { found: false, reason: `no "## ${heading}" section in CHANGELOG.md` };

  let end = lines.length;
  for (let i = start; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break; }
  const section = lines.slice(start, end);

  const vEsc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Accept em dash (—), en dash (–) or hyphen (-) between version and date.
  const headRe = new RegExp(`^###\\s+${vEsc}\\b\\s*[\\u2014\\u2013-]?\\s*(\\d{4}-\\d{2}-\\d{2})?`);

  let hi = -1, date = null;
  for (let i = 0; i < section.length; i++) {
    const m = section[i].match(headRe);
    if (m) { hi = i; date = m[1] || null; break; }
  }
  if (hi === -1) return { found: false, reason: `no "### ${version}" entry under ## ${heading}` };

  let be = section.length;
  for (let i = hi + 1; i < section.length; i++) if (/^### /.test(section[i])) { be = i; break; }
  const body = section.slice(hi + 1, be).join('\n').trim();

  return { found: true, date, hasBody: body.length > 0 };
}

// ── Evaluate each component ──────────────────────────────────────────────────
const { files, hasBase } = changedFiles();
const buckets = { Frontend: [], Backend: [], Repo: [], RideAlong: [] };
for (const f of files) {
  const c = classify(f);
  if (c) buckets[c].push(f);
}

const results = [];
for (const [name, cfg] of Object.entries(COMPONENTS)) {
  const changed = buckets[name];
  const cur = parseVersion(readWorkTree(cfg.versionFile), cfg.re);
  const base = parseVersion(readAtBase(cfg.versionFile), cfg.re);
  const r = { name, base, cur, changed: changed.length, block: cfg.block, status: 'skip', note: '' };

  if (changed.length === 0) {
    r.status = 'skip';
    r.note = 'not in this release';
  } else if (cur == null) {
    r.status = 'fail';
    r.note = `couldn't read a version from ${cfg.versionFile}`;
  } else if (base != null && cmpSemver(cur, base) === 0) {
    r.status = cfg.block ? 'fail' : 'warn';
    r.note = `changed but version still ${cur} — bump ${cfg.versionFile} and add a "## ${cfg.heading}" CHANGELOG entry` +
             (changed.length ? ` (e.g. ${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ', …' : ''})` : '');
  } else if (base != null && cmpSemver(cur, base) < 0) {
    r.status = cfg.block ? 'fail' : 'warn';
    r.note = `version went backwards: live is ${base}, working tree is ${cur}`;
  } else {
    // Properly bumped (or brand-new component). Validate the description.
    const cl = changelogEntry(cfg.heading, cur);
    if (!cl.found) {
      r.status = cfg.block ? 'fail' : 'warn';
      r.note = `bumped ${base ?? '(new)'} → ${cur} but ${cl.reason}`;
    } else if (!cl.hasBody) {
      r.status = cfg.block ? 'fail' : 'warn';
      r.note = `CHANGELOG "### ${cur}" has no description — say what changed and why`;
    } else if (!cl.date) {
      r.status = cfg.block ? 'fail' : 'warn';
      r.note = `CHANGELOG "### ${cur}" is missing a date (expected "### ${cur} — ${TODAY}")`;
    } else if (cl.date !== TODAY) {
      r.status = 'warn';
      r.note = `bumped ${base ?? '(new)'} → ${cur}, but CHANGELOG is dated ${cl.date}, not today (${TODAY})`;
    } else {
      r.status = 'pass';
      r.note = `bumped ${base ?? '(new)'} → ${cur}, CHANGELOG ${cl.date}`;
    }
  }
  results.push(r);
}

const rideAlong = buckets.RideAlong;
const fails = results.filter((r) => r.status === 'fail');
const warns = results.filter((r) => r.status === 'warn');
const overall = fails.length ? 'FAIL' : 'PASS';

// ── Report ───────────────────────────────────────────────────────────────────
if (JSON_OUT) {
  console.log(JSON.stringify({
    overall, base: BASE, hasBase, today: TODAY,
    components: results, rideAlong, failCount: fails.length, warnCount: warns.length,
  }, null, 2));
} else {
  const baseSha = hasBase ? (() => { try { return git(`git rev-parse --short ${BASE}`); } catch { return '?'; } })() : '(none)';
  const icon = { pass: '✓', fail: '✗', warn: '⚠', skip: '·' };
  console.log(`\nRelease validation  (base: ${BASE} @ ${baseSha}, today ${TODAY})\n`);
  for (const r of results) {
    const arrow = r.status === 'skip' ? '' : `${r.base ?? '(new)'} → ${r.cur ?? '?'}`;
    console.log(`  ${icon[r.status]} ${r.name.padEnd(9)} ${arrow.padEnd(18)} ${r.note}`);
  }
  if (rideAlong.length) console.log(`\n  · tests/** ride along — no bump required (${rideAlong.length} file${rideAlong.length > 1 ? 's' : ''})`);
  console.log('');
  if (overall === 'FAIL') {
    console.log(`RESULT: FAIL — ${fails.length} blocking problem${fails.length > 1 ? 's' : ''}. Fix the above, then re-run.`);
  } else if (warns.length) {
    console.log(`RESULT: PASS — with ${warns.length} warning${warns.length > 1 ? 's' : ''} (review, but not blocking).`);
  } else {
    console.log('RESULT: PASS — every shipped component is bumped and described.');
  }
  console.log('');
}

process.exit(overall === 'FAIL' ? 1 : 0);
