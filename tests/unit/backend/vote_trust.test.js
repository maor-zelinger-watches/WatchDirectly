/**
 * Executable tests for the vote-trust / anti-Sybil gate (SEC-Sybil), evaluating
 * the REAL apps-script/Code.gs against in-memory sheet stubs.
 *
 * The gate: a vote from a low-tenure account (first_seen_at younger than the
 * trust window) is still recorded in the Votes tab, but does NOT move the
 * ranking vote_count — and the row is stamped counted='false' so un-voting it
 * later, after the account has aged in, never drifts the count. Enforcement is
 * gated by the Meta `vote_trust_enabled` toggle; while off (the rollout
 * default) every vote counts (observe-only).
 *
 * These pin the four behaviors that the rest of the suite (which runs in the
 * observe default) doesn't exercise:
 *   1. observe mode: a brand-new account's vote still counts;
 *   2. enforce + low tenure: recorded counted='false', vote_count unmoved;
 *   3. enforce + aged-in account: counts normally;
 *   4. no drift: an uncounted vote withdrawn after the account ages in leaves
 *      vote_count where it was (never negative/off-by-one).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');
const CLIENT_ID = SRC.match(/GOOGLE_CLIENT_ID\s*=\s*'([^']+)'/)[1];
const idOf = (key) => SRC.match(new RegExp(key + ":\\s*'([^']+)'"))[1];
const IDS = { META: idOf('META'), CUSTOMERS: idOf('CUSTOMERS'), VIDEOS: idOf('VIDEOS'), BLOCKED: idOf('BLOCKED') };
const nowSec = () => Math.floor(Date.now() / 1000);
const HOUR = 60 * 60 * 1000;

/** A general in-memory sheet: header + data rows, with the range API Code.gs uses. */
function gridSheet(rows, name) {
  const grid = rows.map((r) => r.slice());
  return {
    _grid: grid,
    getName: () => name,
    setName(n) { name = n; },
    getLastRow: () => grid.length,
    getLastColumn: () => grid.reduce((m, r) => Math.max(m, r.length), 0),
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
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
 *   - firstSeenMsAgo: the voter's tenure (ms ago); omit for "no customer row yet"
 *   - voteRows / videoRows: initial Votes / Videos data rows
 *   - email: voter email (default user@example.com)
 */
function load(opts = {}) {
  const email = opts.email || 'user@example.com';
  const metaRows = [['key', 'value']];
  if (opts.enabled !== undefined) metaRows.push(['vote_trust_enabled', opts.enabled]);
  if (opts.tenureHours !== undefined) metaRows.push(['vote_trust_tenure_hours', String(opts.tenureHours)]);

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

  const customersSS = {
    getSheetByName: (n) => ({ Customers: customers, Votes: votes }[n] || null),
    getSheets: () => [customers, votes],
    insertSheet: (n) => (n === 'Customers' ? customers : votes),
  };
  const single = (s) => ({ getSheets: () => [s], getSheetByName: (n) => (n === 'Archive' ? null : null) });
  const SpreadsheetApp = {
    openById: (id) => {
      if (id === IDS.CUSTOMERS) return customersSS;
      if (id === IDS.VIDEOS) return single(videos);
      if (id === IDS.BLOCKED) return single(blocked);
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
  const names = ['handleVote'];
  const factory = new Function(...Object.keys(globals), `${SRC}\nreturn { ${names.join(', ')} };`);
  return { be: factory(...Object.values(globals)), votes, videos, customers, cache };
}

const voteCount = (videos) => Number(videos._grid.find((r) => r[0] === 'vidX')[1]);
const countedFlag = (votes) => { const r = votes._grid.find((x) => x[1] === 'vidX'); return r ? r[4] : undefined; };

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
    const { be, votes, videos } = load({ enabled: 'true', firstSeenMsAgo: 1 * HOUR }); // 1h < 24h window
    const res = be.handleVote({ videoId: 'vidX', token: 't' });
    expect(res.status).toBe('ok');
    expect(res.voted).toBe(true);         // the button still lights up
    expect(res.vote_count).toBe(0);       // ...but the ranking count is untouched
    expect(voteCount(videos)).toBe(0);
    expect(countedFlag(votes)).toBe('false');
  });

  it('counts a vote from an account past the trust window', () => {
    const { be, votes, videos } = load({ enabled: 'true', firstSeenMsAgo: 48 * HOUR }); // aged in
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
      enabled: 'true',
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
