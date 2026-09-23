/**
 * Executable tests for the vote-trust / anti-Sybil gate (SEC-Sybil), evaluating
 * the REAL apps-script/Code.gs against in-memory sheet stubs.
 *
 * The gate: a vote from a low-tenure account (first_seen_at younger than the
 * trust window) is still recorded in the Votes tab, but does NOT move the
 * ranking vote_count — and the row is stamped counted='false' so un-voting it
 * later, after the account has aged in, never drifts the count. Enforcement is
 * gated by the Meta `vote_trust_enabled` toggle AND by the tenure clock having
 * run one full window since the column was introduced (1.24.1); while not
 * enforcing (the rollout default) every vote counts (observe-only).
 *
 * Covered:
 *   1. observe mode: a brand-new account's vote still counts;
 *   2. enforce + low tenure: recorded counted='false', vote_count unmoved;
 *   3. enforce + aged-in account: counts normally;
 *   4. no drift: an uncounted vote withdrawn after the account ages in leaves
 *      vote_count where it was;
 *   5. (1.24.1) the toggle is inert until CLOCK_START + window — flipping it
 *      early can't gate the whole pre-existing user base;
 *   6. (1.24.1) bootstrap caches first_seen, so a vote resolves tenure with no
 *      CUSTOMERS rescan;
 *   7. (1.24.1) the rollout signals are WARN: written at log_level=WARN, and
 *      (documenting the gotcha) silently dropped at the default ERROR level.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');
const CLIENT_ID = SRC.match(/GOOGLE_CLIENT_ID\s*=\s*'([^']+)'/)[1];
const CLOCK_START = Date.parse(SRC.match(/VOTE_TRUST_CLOCK_START_ISO\s*=\s*'([^']+)'/)[1]);
const idOf = (key) => SRC.match(new RegExp(key + ":\\s*'([^']+)'"))[1];
const IDS = { META: idOf('META'), CUSTOMERS: idOf('CUSTOMERS'), VIDEOS: idOf('VIDEOS'), BLOCKED: idOf('BLOCKED'), LOGS: idOf('LOGS') };
const nowSec = () => Math.floor(Date.now() / 1000);
const HOUR = 60 * 60 * 1000;

/** A general in-memory sheet: header + data rows, with the range API Code.gs uses. */
function gridSheet(rows, name) {
  const grid = rows.map((r) => r.slice());
  const sheet = {
    _grid: grid,
    _scans: 0, // getDataRange() calls — how many full scans this sheet took
    getName: () => name,
    setName(n) { name = n; },
    getLastRow: () => grid.length,
    getLastColumn: () => grid.reduce((m, r) => Math.max(m, r.length), 0),
    getDataRange() { sheet._scans++; return { getValues: () => grid.map((r) => r.slice()) }; },
    getRange: (row, col, numRows = 1, numCols = 1) => ({
      getValues() {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const src = grid[row - 1 + r] || [];
          const line = [];
          for (let c = 0; c < numCols; c++) line.push(src[col - 1 + c] === undefined ? '' : src[col - 1 + c]);
          out.push(line);
        }
        return out;
      },
      setValues(values) {
        for (let r = 0; r < values.length; r++) {
          const target = row - 1 + r;
          while (grid.length <= target) grid.push([]);
          for (let c = 0; c < values[r].length; c++) grid[target][col - 1 + c] = values[r][c];
        }
        return this;
      },
      setValue(v) { while (grid.length < row) grid.push([]); grid[row - 1][col - 1] = v; return this; },
      setNumberFormat() { return this; },
      clearContent() { return this; },
    }),
    appendRow: (r) => { grid.push(r.slice()); },
    deleteRow: (r) => { grid.splice(r - 1, 1); },
  };
  return sheet;
}

function memoryCache() {
  const store = new Map();
  const svc = { getScriptCache: () => ({ get: (k) => (store.has(k) ? store.get(k) : null), put: (k, v) => store.set(k, v), remove: (k) => store.delete(k) }) };
  return { svc, store };
}
function memoryProps() {
  const store = new Map();
  return { getScriptProperties: () => ({ getProperty: (k) => (store.has(k) ? store.get(k) : null), setProperty: (k, v) => store.set(k, v), deleteProperty: (k) => store.delete(k) }) };
}

const CUSTOMER_HEADERS = ['email', 'name', 'marketing_consent', 'consent_updated_at', 'first_seen_at', 'source'];

/**
 * Loads Code.gs wired to routed spreadsheets. `opts`:
 *   - enabled: Meta vote_trust_enabled value ('true' to enforce)
 *   - tenureHours: Meta vote_trust_tenure_hours override
 *   - logLevel: Meta log_level (absent → the ERROR default)
 *   - firstSeenMsAgo: the voter's tenure (ms ago); omit for "no customer row yet"
 *   - voteRows / videoRows: initial Votes / Videos data rows
 *   - email: voter email (default user@example.com)
 */
function load(opts = {}) {
  const email = opts.email || 'user@example.com';
  const metaRows = [['key', 'value']];
  if (opts.enabled !== undefined) metaRows.push(['vote_trust_enabled', opts.enabled]);
  if (opts.tenureHours !== undefined) metaRows.push(['vote_trust_tenure_hours', String(opts.tenureHours)]);
  if (opts.logLevel !== undefined) metaRows.push(['log_level', opts.logLevel]);

  const meta = gridSheet(metaRows, 'Meta');
  const votes = gridSheet([['vote_id', 'video_id', 'user_email', 'created_at', 'counted'], ...(opts.voteRows || [])], 'Votes');
  const customerData = [CUSTOMER_HEADERS.slice()];
  if (opts.firstSeenMsAgo !== undefined) {
    const iso = new Date(Date.now() - opts.firstSeenMsAgo).toISOString();
    customerData.push([email, 'User', '', '', iso, 'google_signin']);
  }
  const customers = gridSheet(customerData, 'Customers');
  const videos = gridSheet([['video_id', 'vote_count', 'comment_count'], ...(opts.videoRows || [['vidX', 0, 0]])], 'Videos');
  const blocked = gridSheet([['email']], 'Blocked');
  const logs = gridSheet([['timestamp', 'level', 'source', 'message']], 'Logs');

  const customersSS = {
    getSheetByName: (n) => ({ Customers: customers, Votes: votes }[n] || null),
    getSheets: () => [customers, votes],
    insertSheet: (n) => (n === 'Customers' ? customers : votes),
  };
  const single = (s) => ({ getSheets: () => [s], getSheetByName: () => null });
  const SpreadsheetApp = {
    openById: (id) => {
      if (id === IDS.CUSTOMERS) return customersSS;
      if (id === IDS.VIDEOS) return single(videos);
      if (id === IDS.BLOCKED) return single(blocked);
      if (id === IDS.LOGS) return single(logs);
      return single(meta); // META (and any fallback)
    },
  };

  const cache = memoryCache();
  const globals = {
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({
      aud: CLIENT_ID, iss: 'accounts.google.com', exp: nowSec() + 3600, email, email_verified: 'true', name: 'User', picture: '',
    }) }) },
    SpreadsheetApp,
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: cache.svc,
    PropertiesService: memoryProps(),
    Utilities: {
      getUuid: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      computeDigest: (_a, s) => String(s).split('').map((c) => c.charCodeAt(0)),
      base64EncodeWebSafe: (b) => (Array.isArray(b) ? b.join('_') : String(b)),
      computeHmacSha256Signature: () => [1, 2, 3],
      sleep() {},
      DigestAlgorithm: { MD5: 'MD5', SHA_256: 'SHA_256' },
    },
    Logger: { log() {} },
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
    ScriptApp: {}, XmlService: {},
  };
  const names = ['handleVote', 'readOrCreateCustomer', 'voterFirstSeenMs', 'isVoteTrustEnforced'];
  const factory = new Function(...Object.keys(globals), `${SRC}\nreturn { ${names.join(', ')} };`);
  return { be: factory(...Object.values(globals)), votes, videos, customers, logs, cache };
}

const voteCount = (videos) => Number(videos._grid.find((r) => r[0] === 'vidX')[1]);
const countedFlag = (votes) => { const r = votes._grid.find((x) => x[1] === 'vidX'); return r ? r[4] : undefined; };
const logLines = (logs, needle) => logs._grid.slice(1).filter((r) => String(r[3]).includes(needle));

// Enforce-mode handleVote tests use a 2h Meta window: the enforcement guard
// requires CLOCK_START + window to have elapsed, and CLOCK_START + 2h is long
// past, so these stay enforced (and deterministic) regardless of wall-clock —
// whereas the 24h default would only enforce a day after the column shipped.
const ENFORCED = { enabled: 'true', tenureHours: 2 };

describe('vote trust — observe mode (enforcement off)', () => {
  it('counts a brand-new account\'s vote (nothing is gated until the toggle is on)', () => {
    const { be, votes, videos } = load({ firstSeenMsAgo: 0 }); // zero tenure, but observe
    const res = be.handleVote({ videoId: 'vidX', token: 't' });
    expect(res.status).toBe('ok');
    expect(res.voted).toBe(true);
    expect(res.vote_count).toBe(1);       // counted
    expect(voteCount(videos)).toBe(1);
    expect(countedFlag(votes)).toBe('true');
  });
});

describe('vote trust — enforcement on', () => {
  it('records a low-tenure vote but does NOT move vote_count (counted=false)', () => {
    const { be, votes, videos } = load({ ...ENFORCED, firstSeenMsAgo: 1 * HOUR }); // 1h < 2h window
    const res = be.handleVote({ videoId: 'vidX', token: 't' });
    expect(res.status).toBe('ok');
    expect(res.voted).toBe(true);         // the button still lights up
    expect(res.vote_count).toBe(0);       // ...but the ranking count is untouched
    expect(voteCount(videos)).toBe(0);
    expect(countedFlag(votes)).toBe('false');
  });

  it('counts a vote from an account past the trust window', () => {
    const { be, votes, videos } = load({ ...ENFORCED, firstSeenMsAgo: 48 * HOUR }); // aged in
    const res = be.handleVote({ videoId: 'vidX', token: 't' });
    expect(res.vote_count).toBe(1);
    expect(voteCount(videos)).toBe(1);
    expect(countedFlag(votes)).toBe('true');
  });

  it('respects the Meta tenure override (vote_trust_tenure_hours)', () => {
    // 2h-old account, but the window is lowered to 1h → trusted now.
    const { be, videos } = load({ enabled: 'true', firstSeenMsAgo: 2 * HOUR, tenureHours: 1 });
    expect(be.handleVote({ videoId: 'vidX', token: 't' }).vote_count).toBe(1);
    expect(voteCount(videos)).toBe(1);
  });

  it('no drift: an uncounted vote withdrawn later never pushes vote_count below its real total', () => {
    // A video that already has one legitimate vote (count = 1). A low-tenure
    // account votes (uncounted), then un-votes: the count must return to 1, not 0.
    const { be, videos, cache } = load({
      ...ENFORCED,
      firstSeenMsAgo: 1 * HOUR,
      videoRows: [['vidX', 1, 0]],
      voteRows: [['v_legit', 'vidX', 'other@example.com', 't', 'true']],
    });
    const first = be.handleVote({ videoId: 'vidX', token: 't' }); // low-tenure vote — uncounted
    expect(first.voted).toBe(true);
    expect(voteCount(videos)).toBe(1); // unchanged — the gamed vote didn't count

    cache.store.clear(); // clear the 2s per-user vote throttle (real toggles are seconds apart)
    const second = be.handleVote({ videoId: 'vidX', token: 't' }); // same account un-votes
    expect(second.voted).toBe(false);
    expect(voteCount(videos)).toBe(1); // still 1 — no decrement for a vote that never counted
  });
});

describe('vote trust — enforcement guard (1.24.1: the toggle is inert until the clock has run a window)', () => {
  it('toggle on but the window has not elapsed since CLOCK_START → not enforced', () => {
    const { be } = load({ enabled: 'true' }); // default 24h window
    // Every pre-existing account was stamped at CLOCK_START; enforcing before
    // one window has passed would gate all of them.
    expect(be.isVoteTrustEnforced(CLOCK_START + 23 * HOUR)).toBe(false);
    expect(be.isVoteTrustEnforced(CLOCK_START)).toBe(false);
  });

  it('toggle on and a full window has elapsed → enforced', () => {
    const { be } = load({ enabled: 'true' });
    expect(be.isVoteTrustEnforced(CLOCK_START + 24 * HOUR)).toBe(true);
    expect(be.isVoteTrustEnforced(CLOCK_START + 30 * 24 * HOUR)).toBe(true);
  });

  it('toggle off → never enforced, however much time has passed', () => {
    const { be } = load({});
    expect(be.isVoteTrustEnforced(CLOCK_START + 365 * 24 * HOUR)).toBe(false);
  });

  it('handleVote honours the guard: toggle on, default window, early → the vote still counts', () => {
    // Same low-tenure account that is gated under ENFORCED; with the default 24h
    // window the guard only lifts a day after CLOCK_START. Whether that has
    // passed depends on the wall clock, so assert the invariant either way:
    // gated ⇔ enforced. What must NEVER happen is a count snap-back while
    // isVoteTrustEnforced(now) is false.
    const { be, videos } = load({ enabled: 'true', firstSeenMsAgo: 1 * HOUR });
    const enforcedNow = be.isVoteTrustEnforced(Date.now());
    const res = be.handleVote({ videoId: 'vidX', token: 't' });
    expect(voteCount(videos)).toBe(enforcedNow ? 0 : 1);
    expect(res.vote_count).toBe(enforcedNow ? 0 : 1);
  });
});

describe('vote trust — first_seen is cached at bootstrap (1.24.1: no CUSTOMERS rescan on a vote)', () => {
  it('after bootstrap, resolving tenure for a vote takes zero additional CUSTOMERS scans', () => {
    const { be, customers } = load({ firstSeenMsAgo: 48 * HOUR });
    be.readOrCreateCustomer('user@example.com', 'User'); // sign-in bootstrap: scans once, caches first_seen
    const scansAfterBootstrap = customers._scans;
    expect(scansAfterBootstrap).toBeGreaterThan(0);

    const ms = be.voterFirstSeenMs('user@example.com', 'User'); // the vote path
    expect(Date.now() - ms).toBeGreaterThanOrEqual(48 * HOUR - 1000);
    expect(customers._scans).toBe(scansAfterBootstrap); // cache hit — CUSTOMERS untouched
  });

  it('a cold vote (no bootstrap) still resolves tenure, then caches it for the next one', () => {
    const { be, customers } = load({ firstSeenMsAgo: 48 * HOUR });
    be.voterFirstSeenMs('user@example.com', 'User'); // miss → one scan
    const afterFirst = customers._scans;
    expect(afterFirst).toBe(1);
    be.voterFirstSeenMs('user@example.com', 'User'); // hit
    expect(customers._scans).toBe(afterFirst);
  });
});

describe('vote trust — rollout signals are visible at log_level=WARN (1.24.1)', () => {
  it('writes the "Gated low-tenure vote" WARN when log_level is WARN', () => {
    const { be, logs } = load({ ...ENFORCED, firstSeenMsAgo: 1 * HOUR, logLevel: 'WARN' });
    be.handleVote({ videoId: 'vidX', token: 't' });
    const lines = logLines(logs, 'Gated low-tenure vote on vidX');
    expect(lines.length).toBe(1);
    expect(lines[0][1]).toBe('WARN');
  });

  it('writes the "Would gate" WARN in observe mode too (the readiness signal)', () => {
    const { be, logs } = load({ firstSeenMsAgo: 0, logLevel: 'WARN' }); // observe: toggle off
    be.handleVote({ videoId: 'vidX', token: 't' });
    expect(logLines(logs, 'Would gate low-tenure vote on vidX').length).toBe(1);
  });

  it('is silent at the default log_level (ERROR) — why the operator must set WARN to observe', () => {
    const { be, logs } = load({ ...ENFORCED, firstSeenMsAgo: 1 * HOUR }); // no log_level row
    be.handleVote({ videoId: 'vidX', token: 't' });
    expect(logLines(logs, 'low-tenure').length).toBe(0);
  });
});
