/**
 * Executable tests for session revocation + lifetime hardening on the backend
 * (branch fix/be-session-revocation): findings SEC2/BE15 and SEC9.
 *
 * Like the sibling backend tests (handlers / input_validation / abuse_rate_limits),
 * these eval the REAL apps-script/Code.gs against in-memory Sheet / CacheService /
 * PropertiesService stubs and exercise the shipped functions — not copies.
 *
 * Coverage:
 *  - SEC2/BE15: minted tokens embed the session version `v`; a bumped version
 *    (server signOut, blockUser) retires every outstanding token; legacy tokens
 *    without `v` are rejected (the one-time cutover re-auth); renewals carry the
 *    ORIGINAL iat forward, cap exp at iat + SESSION_MAX_AGE_DAYS, and are
 *    refused entirely past that age; blocked users can't mint or read bootstrap.
 *  - SEC9: the admin `refresh` action no longer works over GET (token in a URL);
 *    it's admin-gated over POST like `logs`.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');
const ID_OF = (key) => SRC.match(new RegExp(`${key}:\\s*'([^']+)'`))[1];
const nowSec = () => Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60;

// ------------------------------------------------------------------
// Stubs
// ------------------------------------------------------------------

function memoryCache() {
  const store = new Map();
  return {
    getScriptCache: () => ({
      get: (k) => (store.has(k) ? store.get(k) : null),
      put: (k, v) => { store.set(k, v); },
      remove: (k) => { store.delete(k); },
    }),
  };
}

function memoryProps(seed = {}) {
  const store = { ...seed };
  return {
    getScriptProperties: () => ({
      getProperty: (k) => (k in store ? store[k] : null),
      setProperty: (k, v) => { store[k] = String(v); },
      deleteProperty: (k) => { delete store[k]; },
    }),
  };
}

/** A sheet over a mutable grid; appendRow works, cell writes are accepted. */
function gridSheet(rows) {
  const grid = rows.map((r) => r.slice());
  return {
    _grid: grid,
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getLastRow: () => grid.length,
    getRange: (row, col) => ({
      setValue: (v) => { grid[row - 1][col - 1] = v; },
      setNumberFormat() { return this; },
      setValues() { return this; },
    }),
    appendRow: (r) => { grid.push(r.slice()); },
  };
}

/**
 * Utilities with REAL base64url + HMAC-SHA256, so mint/verify exercise the
 * shipped crypto path end to end (encode → sign → constant-time compare →
 * decode) instead of a stub that trivially matches itself.
 */
function realCryptoUtilities() {
  return {
    getUuid: () => crypto.randomUUID(),
    sleep() {},
    computeDigest: (_algo, str) => Array.from(crypto.createHash('sha256').update(String(str)).digest()),
    computeHmacSha256Signature: (value, key) =>
      Array.from(crypto.createHmac('sha256', String(key)).update(String(value)).digest()),
    base64EncodeWebSafe: (input) =>
      (Array.isArray(input) ? Buffer.from(input) : Buffer.from(String(input), 'utf8')).toString('base64url'),
    base64DecodeWebSafe: (s) => Array.from(Buffer.from(String(s), 'base64url')),
    newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
    DigestAlgorithm: { SHA_256: 'SHA_256', MD5: 'MD5' },
  };
}

/**
 * Loads the real Code.gs with META/BLOCKED grids wired to getSheet, and
 * handleRefresh stubbed to a counter (a real one would crawl the network).
 */
function loadSession({ metaRows = [], blockedRows = [] } = {}) {
  const metaSheet = gridSheet([['key', 'value'], ...metaRows]);
  const blockedSheet = gridSheet([['email', 'blocked_at'], ...blockedRows]);
  const genericSheet = gridSheet([['ts']]);
  const byId = {
    [ID_OF('META')]: metaSheet,
    [ID_OF('BLOCKED')]: blockedSheet,
  };
  const globals = {
    UrlFetchApp: { fetch: () => { throw new Error('no network in this suite'); } },
    SpreadsheetApp: { openById: (id) => ({ getSheets: () => [byId[id] || genericSheet], getSheetByName: () => null }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: memoryCache(),
    PropertiesService: memoryProps(),
    Utilities: realCryptoUtilities(),
    Logger: { log() {} },
    ContentService: {
      createTextOutput: (s) => ({ setMimeType: () => ({ payload: JSON.parse(s) }) }),
      MimeType: { JSON: 'json' },
    },
    ScriptApp: {}, XmlService: {},
  };
  const names = [
    'mintSessionToken', 'verifySessionToken', 'sessionSignature',
    'getSessionVersion', 'bumpSessionVersion',
    'handleSession', 'handleSignOut', 'handleBootstrap',
    'isUserBlocked', 'blockUser', 'doGet', 'doPost',
    'SESSION_TOKEN_PREFIX', 'SESSION_MAX_AGE_DAYS',
  ];
  // Redefine AFTER the source so the later declaration wins: refresh must be
  // observable without crawling, and bootstrap's sheet reads aren't under test.
  const overrides = `
    var __refreshCalls = 0;
    function handleRefresh() { __refreshCalls++; return { status: 'ok' }; }
    function readUserVoteIds() { return ['vid1']; }
    function readUserStarChannels() { return ['chan1']; }
  `;
  const factory = new Function(
    ...Object.keys(globals),
    `${SRC}\n${overrides}\nreturn { ${names.join(', ')}, refreshCalls: () => __refreshCalls };`
  );
  return { ...factory(...Object.values(globals)), metaSheet, blockedSheet };
}

const USER = { email: 'ada@example.com', name: 'Ada', picture: 'https://x/p.png' };

/** Decodes the payload of a minted wds1 token. */
function payloadOf(token) {
  const body = token.split('.')[1];
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}

/** A signed token with an arbitrary payload (uses the loaded instance's HMAC). */
function signedToken(be, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return be.SESSION_TOKEN_PREFIX + body + '.' + be.sessionSignature(body);
}

// ==================================================================
// SEC2/BE15 — session versioning (the revocation lever)
// ==================================================================

describe('SEC2/BE15 — session version claim', () => {
  it('mints v matching the current session version (0 by default) and round-trips', () => {
    const be = loadSession();
    const tok = be.mintSessionToken(USER);

    expect(payloadOf(tok).v).toBe(0);
    const v = be.verifySessionToken(tok);
    expect(v).toMatchObject({ email: USER.email, name: USER.name, picture: USER.picture });
    expect(v.iat).toBe(payloadOf(tok).iat);
  });

  it('a version bump retires an already-minted token', () => {
    const be = loadSession();
    const tok = be.mintSessionToken(USER);
    expect(be.verifySessionToken(tok)).not.toBeNull();

    be.bumpSessionVersion(USER.email);

    expect(be.getSessionVersion(USER.email)).toBe(1);
    expect(be.verifySessionToken(tok)).toBeNull();
    // A token minted AFTER the bump carries the new version and verifies.
    expect(be.verifySessionToken(be.mintSessionToken(USER))).not.toBeNull();
  });

  it('rejects a legacy token without v — the one-time cutover re-auth', () => {
    const be = loadSession();
    const legacy = signedToken(be, {
      e: USER.email, n: USER.name, p: USER.picture,
      iat: nowSec(), exp: nowSec() + 3600,
    });
    expect(be.verifySessionToken(legacy)).toBeNull();
  });

  it('rejects a validly-signed token with a wrong v', () => {
    const be = loadSession();
    const wrongV = signedToken(be, {
      e: USER.email, n: USER.name, p: USER.picture,
      iat: nowSec(), exp: nowSec() + 3600, v: 7,
    });
    expect(be.verifySessionToken(wrongV)).toBeNull();
  });

  it('versions are per-user: bumping one user leaves another signed in', () => {
    const be = loadSession();
    const other = { email: 'bob@example.com', name: 'Bob', picture: '' };
    const adaTok = be.mintSessionToken(USER);
    const bobTok = be.mintSessionToken(other);

    be.bumpSessionVersion(USER.email);

    expect(be.verifySessionToken(adaTok)).toBeNull();
    expect(be.verifySessionToken(bobTok)).not.toBeNull();
  });
});

// ==================================================================
// SEC2/BE15 — absolute session lifetime across renewals
// ==================================================================

describe('SEC2/BE15 — renewal carries iat, capped at max age', () => {
  it('a renewal carries the ORIGINAL iat forward and re-issues', () => {
    const be = loadSession();
    const originIat = nowSec() - 10 * DAY;
    const tok = signedToken(be, {
      e: USER.email, n: USER.name, p: USER.picture,
      iat: originIat, exp: nowSec() + 3600, v: 0,
    });

    const res = be.handleSession({ token: tok });

    expect(res.status).toBe('ok');
    const renewed = payloadOf(res.sessionToken);
    expect(renewed.iat).toBe(originIat);
    expect(renewed.exp).toBeLessThanOrEqual(renewed.iat + be.SESSION_MAX_AGE_DAYS * DAY);
    expect(res.exp).toBe(renewed.exp);
  });

  it('near the cap, exp is clamped to iat + SESSION_MAX_AGE_DAYS (not now + TTL)', () => {
    const be = loadSession();
    const originIat = nowSec() - (be.SESSION_MAX_AGE_DAYS - 1) * DAY; // 1 day of life left
    const tok = signedToken(be, {
      e: USER.email, n: USER.name, p: USER.picture,
      iat: originIat, exp: nowSec() + 3600, v: 0,
    });

    const res = be.handleSession({ token: tok });

    expect(res.status).toBe('ok');
    expect(payloadOf(res.sessionToken).exp).toBe(originIat + be.SESSION_MAX_AGE_DAYS * DAY);
  });

  it('refuses a renewal past the absolute max age', () => {
    const be = loadSession();
    const tok = signedToken(be, {
      e: USER.email, n: USER.name, p: USER.picture,
      iat: nowSec() - (be.SESSION_MAX_AGE_DAYS * DAY + 60), exp: nowSec() + 3600, v: 0,
    });

    const res = be.handleSession({ token: tok });

    expect(res.status).toBe('error');
    expect(res.sessionToken).toBeUndefined();
  });
});

// ==================================================================
// SEC2/BE15 — server sign-out and blocking
// ==================================================================

describe('SEC2/BE15 — handleSignOut', () => {
  it('revokes every outstanding session for the caller', () => {
    const be = loadSession();
    const tokA = be.mintSessionToken(USER); // "this browser"
    const tokB = be.mintSessionToken(USER); // "the kiosk they forgot"

    const res = be.handleSignOut({ token: tokA });

    expect(res).toMatchObject({ status: 'ok', revoked: true });
    expect(be.verifySessionToken(tokA)).toBeNull();
    expect(be.verifySessionToken(tokB)).toBeNull();
  });

  it('an invalid token has nothing to revoke and still returns ok (best-effort)', () => {
    const be = loadSession();
    const res = be.handleSignOut({ token: 'wds1.garbage.sig' });
    expect(res).toMatchObject({ status: 'ok', revoked: false });
  });

  it('doPost routes the signOut action', () => {
    const be = loadSession();
    const tok = be.mintSessionToken(USER);
    const out = be.doPost({ postData: { contents: JSON.stringify({ action: 'signOut', token: tok }) } });
    expect(out.payload).toMatchObject({ status: 'ok', revoked: true });
    expect(be.verifySessionToken(tok)).toBeNull();
  });
});

describe('SEC2/BE15 — blocked users', () => {
  it('handleSession refuses to mint for a blocked user', () => {
    const be = loadSession({ blockedRows: [[USER.email, '2026-01-01']] });
    const tok = be.mintSessionToken(USER); // token from before the block
    const res = be.handleSession({ token: tok });
    expect(res.status).toBe('error');
    expect(res.sessionToken).toBeUndefined();
  });

  it('handleBootstrap refuses a blocked user whose token still verifies', () => {
    const be = loadSession({ blockedRows: [[USER.email, '2026-01-01']] });
    const tok = be.mintSessionToken(USER);
    const res = be.handleBootstrap({ token: tok });
    expect(res.status).toBe('error');
    expect(res.video_ids).toBeUndefined();
  });

  it('blockUser appends the row AND kills the existing session immediately', () => {
    const be = loadSession();
    const tok = be.mintSessionToken(USER);
    expect(be.verifySessionToken(tok)).not.toBeNull();

    be.blockUser(USER.email);

    expect(be.isUserBlocked(USER.email)).toBe(true);
    expect(be.verifySessionToken(tok)).toBeNull();
    // Blocking again must not duplicate the sheet row (but still bumps).
    be.blockUser(USER.email);
    const rows = be.blockedSheet._grid.filter((r) => r[0] === USER.email);
    expect(rows.length).toBe(1);
  });
});

// ==================================================================
// SEC9 — admin refresh moved off GET
// ==================================================================

describe('SEC9 — refresh is POST-only', () => {
  const ADMIN = 'sekrit-admin-token';
  const withAdmin = () => loadSession({ metaRows: [['admin_token', ADMIN]] });

  it('GET refresh no longer runs the crawl — even with a valid admin token', () => {
    const be = withAdmin();
    const out = be.doGet({ parameter: { action: 'refresh', token: ADMIN } });
    expect(out.payload.status).toBe('error');
    expect(be.refreshCalls()).toBe(0);
  });

  it('POST refresh with the admin token runs the crawl', () => {
    const be = withAdmin();
    const out = be.doPost({ postData: { contents: JSON.stringify({ action: 'refresh', token: ADMIN }) } });
    expect(out.payload.status).toBe('ok');
    expect(be.refreshCalls()).toBe(1);
  });

  it('POST refresh without a valid admin token is Unauthorized', () => {
    const be = withAdmin();
    const out = be.doPost({ postData: { contents: JSON.stringify({ action: 'refresh', token: 'wrong' }) } });
    expect(out.payload).toMatchObject({ status: 'error', message: 'Unauthorized' });
    expect(be.refreshCalls()).toBe(0);
  });
});
