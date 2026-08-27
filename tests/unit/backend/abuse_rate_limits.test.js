/**
 * Executable tests for the abuse / rate-limit hardening on the backend
 * (branch fix/be-abuse-rate-limits): findings SEC1/BE4, SEC3/BE5, BE5, BE11, SEC5.
 *
 * Like the sibling backend tests (handlers / input_validation / cache_generation),
 * these eval the REAL apps-script/Code.gs against in-memory Sheet / CacheService /
 * PropertiesService / UrlFetchApp stubs and exercise the shipped functions — not
 * copies.
 *
 * Coverage:
 *  - SEC1/BE4: verifyGoogleToken locally rejects a well-formed-but-invalid JWT
 *    (wrong aud / wrong iss / expired) with NO UrlFetchApp call, negatively caches
 *    it, and still lets a valid-looking JWT and a non-JWT token reach tokeninfo.
 *  - SEC3/BE5: handleVote / handleStar block a second call inside the rate window.
 *  - BE5: updateVoteCount's incremental (±1) path yields the right count WITHOUT
 *    re-reading the Votes sheet, and still bumps the cache generation.
 *  - BE11: getVideos / handleTopWeek / handleArchive clamp a negative page and cap
 *    an oversized limit; handleVideo's not-found marker short-circuits a re-lookup.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');
const CLIENT_ID = SRC.match(/GOOGLE_CLIENT_ID\s*=\s*'([^']+)'/)[1];
const nowSec = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------------
// Shared stubs
// ------------------------------------------------------------------

function memoryCache(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    _store: store,
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
    _store: store,
    getScriptProperties: () => ({
      getProperty: (k) => (k in store ? store[k] : null),
      setProperty: (k, v) => { store[k] = String(v); },
      deleteProperty: (k) => { delete store[k]; },
    }),
  };
}

/** A UrlFetchApp whose tokeninfo payload/code is fixed, counting every fetch. */
function countingTokeninfo(payload, code = 200) {
  const state = { calls: 0 };
  return {
    urlFetchApp: {
      fetch: () => {
        state.calls++;
        return { getResponseCode: () => code, getContentText: () => JSON.stringify(payload) };
      },
    },
    state,
  };
}

const validClaims = (over = {}) => ({
  aud: CLIENT_ID, iss: 'accounts.google.com', exp: nowSec() + 3600,
  email: 'user@example.com', email_verified: 'true', name: 'User', picture: 'https://x/p.jpg',
  ...over,
});

// ==================================================================
// SEC1 / BE4 — verifyGoogleToken local pre-flight + negative cache
// ==================================================================

/** Utilities with a REAL base64url decode path (so decodeJwtPayload works). */
function jwtUtilities() {
  return {
    getUuid: () => 'uuid',
    sleep() {},
    // Distinct digest per token → distinct cache keys per token.
    computeDigest: (_algo, str) => Array.from(String(str)).map((c) => c.charCodeAt(0)),
    base64EncodeWebSafe: (bytes) => (Array.isArray(bytes) ? bytes.join(',') : String(bytes)),
    base64DecodeWebSafe: (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
    newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
    DigestAlgorithm: { SHA_256: 'SHA_256', MD5: 'MD5' },
  };
}

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
/** A structurally-valid 3-segment JWT with the given claims (bogus signature). */
function makeJwt(claims) {
  return b64url({ alg: 'RS256', typ: 'JWT' }) + '.' + b64url(claims) + '.' + 'SIGNATURE';
}

function loadAuth(urlFetchApp, cache) {
  const globals = {
    UrlFetchApp: urlFetchApp,
    SpreadsheetApp: { openById: () => ({ getSheets: () => [{ getDataRange: () => ({ getValues: () => [[]] }), appendRow() {} }], getSheetByName: () => null }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: cache || memoryCache(),
    PropertiesService: memoryProps(),
    Utilities: jwtUtilities(),
    Logger: { log() {} },
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
    ScriptApp: {}, XmlService: {},
  };
  const factory = new Function(...Object.keys(globals), `${SRC}\nreturn { verifyGoogleToken, decodeJwtPayload };`);
  return { ...factory(...Object.values(globals)), cache: globals.CacheService };
}

describe('SEC1/BE4 — verifyGoogleToken rejects bad JWTs offline (no tokeninfo fetch)', () => {
  it('rejects a JWT minted for a different audience with ZERO UrlFetchApp calls', () => {
    const { urlFetchApp, state } = countingTokeninfo(validClaims());
    const { verifyGoogleToken } = loadAuth(urlFetchApp);
    const token = makeJwt({ aud: 'attacker.apps.googleusercontent.com', iss: 'accounts.google.com', exp: nowSec() + 3600 });

    expect(verifyGoogleToken(token)).toBeNull();
    expect(state.calls).toBe(0); // never hit the network
  });

  it('rejects an expired JWT with no fetch', () => {
    const { urlFetchApp, state } = countingTokeninfo(validClaims());
    const { verifyGoogleToken } = loadAuth(urlFetchApp);
    const token = makeJwt({ aud: CLIENT_ID, iss: 'accounts.google.com', exp: nowSec() - 10 });

    expect(verifyGoogleToken(token)).toBeNull();
    expect(state.calls).toBe(0);
  });

  it('rejects a JWT with a non-Google issuer with no fetch', () => {
    const { urlFetchApp, state } = countingTokeninfo(validClaims());
    const { verifyGoogleToken } = loadAuth(urlFetchApp);
    const token = makeJwt({ aud: CLIENT_ID, iss: 'evil.example.com', exp: nowSec() + 3600 });

    expect(verifyGoogleToken(token)).toBeNull();
    expect(state.calls).toBe(0);
  });

  it('negatively caches a rejected token — a repeat is refused, still zero fetches', () => {
    const cache = memoryCache();
    const { urlFetchApp, state } = countingTokeninfo(validClaims());
    const { verifyGoogleToken } = loadAuth(urlFetchApp, cache);
    const token = makeJwt({ aud: 'attacker.apps.googleusercontent.com', iss: 'accounts.google.com', exp: nowSec() + 3600 });

    expect(verifyGoogleToken(token)).toBeNull();
    expect(verifyGoogleToken(token)).toBeNull();
    expect(state.calls).toBe(0);
    // The failure was remembered under a negative-cache key.
    const negKeys = Array.from(cache._store.keys()).filter((k) => k.indexOf('tokneg_') === 0);
    expect(negKeys.length).toBe(1);
  });

  it('lets a JWT that passes local pre-flight reach tokeninfo (pre-flight is not a verifier)', () => {
    const { urlFetchApp, state } = countingTokeninfo(validClaims());
    const { verifyGoogleToken } = loadAuth(urlFetchApp);
    // aud/iss/exp all fine locally — the signature still must be checked live.
    const token = makeJwt({ aud: CLIENT_ID, iss: 'accounts.google.com', exp: nowSec() + 3600 });

    const res = verifyGoogleToken(token);
    expect(res).toEqual({ email: 'user@example.com', name: 'User', picture: 'https://x/p.jpg' });
    expect(state.calls).toBe(1); // reached the network to verify the signature
  });

  it('still sends a non-JWT (opaque) token to tokeninfo — backward compatible', () => {
    const { urlFetchApp, state } = countingTokeninfo(validClaims());
    const { verifyGoogleToken } = loadAuth(urlFetchApp);

    expect(verifyGoogleToken('not-a-jwt')).not.toBeNull();
    expect(state.calls).toBe(1);
  });
});

// ==================================================================
// SEC3 / BE5 — vote/star per-user rate limit
// ==================================================================

const VOTE_HEADERS = ['vote_id', 'video_id', 'user_email', 'created_at'];
const STAR_HEADERS = ['star_id', 'channel_name', 'user_email', 'created_at'];
const VIDEO_HEADERS = ['video_id', 'vote_count', 'comment_count'];

function recordingSheet(rows) {
  const grid = rows.map((r) => r.slice());
  return {
    _grid: grid,
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getLastRow: () => grid.length,
    getRange: () => ({ setNumberFormat() { return this; }, setValue() { return this; }, setValues() { return this; } }),
    appendRow: (r) => { grid.push(r.slice()); },
  };
}

function spreadsheetApp(first, named = {}) {
  const ss = { getSheets: () => [first], getSheetByName: (n) => (n in named ? named[n] : null), insertSheet: () => first };
  return { openById: () => ss };
}

function loadWrite(SpreadsheetApp, urlFetchApp) {
  const globals = {
    UrlFetchApp: urlFetchApp,
    SpreadsheetApp,
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: memoryCache(), // shared across calls in one loaded instance
    PropertiesService: memoryProps(),
    Utilities: {
      getUuid: () => '00000000-0000-0000-0000-000000000000', sleep() {},
      computeDigest: () => [], base64EncodeWebSafe: () => 'x',
      DigestAlgorithm: { MD5: 'MD5', SHA_256: 'SHA_256' },
    },
    Logger: { log() {} },
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
    ScriptApp: {}, XmlService: {},
  };
  const factory = new Function(...Object.keys(globals), `${SRC}\nreturn { handleVote, handleStar };`);
  return factory(...Object.values(globals));
}

function okTokeninfo() {
  return { fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(validClaims()) }) };
}

describe('SEC3/BE5 — vote/star rate limit', () => {
  it('blocks a second vote inside the window (keyed per user)', () => {
    const votes = recordingSheet([VOTE_HEADERS.slice()]);
    const videos = recordingSheet([VIDEO_HEADERS.slice()]);
    const be = loadWrite(spreadsheetApp(videos, { Votes: votes, Archive: null }), okTokeninfo());

    const first = be.handleVote({ videoId: 'dQw4w9WgXcQ', token: 't' });
    expect(first.status).toBe('ok');

    const second = be.handleVote({ videoId: 'dQw4w9WgXcQ', token: 't' });
    expect(second.status).toBe('error');
    expect(second.message).toMatch(/too fast/i);
  });

  it('blocks a second star inside the window', () => {
    const stars = recordingSheet([STAR_HEADERS.slice()]);
    const first = recordingSheet([['channel_name', 'user_email']]); // no 'email' col -> not blocked
    const be = loadWrite(spreadsheetApp(first, { Stars: stars }), okTokeninfo());

    const a = be.handleStar({ channel: 'Nico Leonard', token: 't' });
    expect(a.status).toBe('ok');
    expect(a.starred).toBe(true);

    const b = be.handleStar({ channel: 'Nico Leonard', token: 't' });
    expect(b.status).toBe('error');
    expect(b.message).toMatch(/too fast/i);
  });
});

// ==================================================================
// BE5 — updateVoteCount incremental path (no Votes rescan)
// ==================================================================

const VROWS = ['video_id', 'channel_name', 'title', 'url', 'published_at', 'comment_count', 'vote_count', 'media_type', 'expires_at'];

/** Mutable sheet that counts full-grid reads. */
function statSheet(rows) {
  const grid = rows.map((r) => r.slice());
  const stats = { reads: 0 };
  return {
    _grid: grid,
    _stats: stats,
    getDataRange: () => ({ getValues: () => { stats.reads++; return grid.map((r) => r.slice()); } }),
    getRange: (row, col) => ({
      setValue(v) {
        while (grid.length < row) grid.push([]);
        const r = grid[row - 1];
        while (r.length < col) r.push('');
        r[col - 1] = v;
      },
      setValues() {}, setNumberFormat() {},
    }),
    appendRow: (r) => { grid.push(r.slice()); },
    getLastRow: () => grid.length,
  };
}

function loadVoteCount({ videoRows, voteRows }) {
  const videosSheet = statSheet([VROWS, ...videoRows]);
  const votesSheet = statSheet([VOTE_HEADERS, ...(voteRows || [])]);
  const videosSpreadsheet = { getSheets: () => [videosSheet], getSheetByName: () => null };
  const commentsSpreadsheet = {
    getSheets: () => [statSheet([['x']])],
    getSheetByName: (n) => (n === 'Votes' ? votesSheet : null),
    insertSheet: () => votesSheet,
  };
  const byId = { VIDEOS_ID: videosSpreadsheet, COMMENTS_ID: commentsSpreadsheet };

  const globals = {
    SpreadsheetApp: { openById: (id) => byId[id] || { getSheets: () => [statSheet([['key', 'value']])], getSheetByName: () => null } },
    CacheService: memoryCache(),
    PropertiesService: memoryProps(),
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Logger: { log() {} },
    Utilities: {}, UrlFetchApp: {}, ScriptApp: {},
  };
  const patched = SRC
    .replace(/VIDEOS:\s*'[^']+'/, "VIDEOS: 'VIDEOS_ID'")
    .replace(/COMMENTS:\s*'[^']+'/, "COMMENTS: 'COMMENTS_ID'");
  const names = ['updateVoteCount', 'currentCacheGeneration'];
  const factory = new Function(...Object.keys(globals), `${patched}\nreturn { ${names.join(', ')} };`);
  return { ...factory(...Object.values(globals)), videosSheet, votesSheet };
}

describe('BE5 — updateVoteCount incremental (delta) path', () => {
  it('adds +1 to the known row without scanning the Votes sheet, and bumps the generation', () => {
    const now = Date.now();
    const be = loadVoteCount({
      videoRows: [['VID00000001', 'A', 't', 'https://x/1', new Date(now).toISOString(), 0, 5, 'video', '']],
      // A stale, oversized Votes sheet the incremental path must NOT read.
      voteRows: Array.from({ length: 50 }, (_, i) => ['v' + i, 'VID00000001', 'u' + i + '@x', '']),
    });

    const genBefore = be.currentCacheGeneration();
    const count = be.updateVoteCount('VID00000001', 1);

    expect(count).toBe(6);                             // 5 + 1, not the 50 in the Votes sheet
    expect(be.votesSheet._stats.reads).toBe(0);        // Votes sheet never scanned
    expect(be.videosSheet._grid[1][VROWS.indexOf('vote_count')]).toBe(6); // written back
    expect(be.currentCacheGeneration()).toBeGreaterThan(genBefore); // caches invalidated
  });

  it('floors a -1 delta at zero', () => {
    const now = Date.now();
    const be = loadVoteCount({
      videoRows: [['VID00000001', 'A', 't', 'https://x/1', new Date(now).toISOString(), 0, 0, 'video', '']],
    });
    expect(be.updateVoteCount('VID00000001', -1)).toBe(0);
    expect(be.votesSheet._stats.reads).toBe(0);
  });

  it('still recounts from the Votes sheet when NO delta is given (reconcile path)', () => {
    const now = Date.now();
    const be = loadVoteCount({
      videoRows: [['VID00000001', 'A', 't', 'https://x/1', new Date(now).toISOString(), 0, 0, 'video', '']],
      voteRows: [['v1', 'VID00000001', 'a@x', ''], ['v2', 'VID00000001', 'b@x', '']],
    });
    expect(be.updateVoteCount('VID00000001')).toBe(2);  // authoritative recount
    expect(be.votesSheet._stats.reads).toBeGreaterThan(0);
  });
});

// ==================================================================
// BE11 — page/limit clamps + handleVideo not-found marker
// ==================================================================

const iso = (ms) => new Date(ms).toISOString();

function manyVideos(n, atBase) {
  return Array.from({ length: n }, (_, i) => [
    'VID' + String(i).padStart(8, '0'), 'Chan', 'title ' + i, 'https://x/' + i,
    iso(atBase - i * 60000), 0, 0, 'video', '',
  ]);
}

function loadReads({ videoRows = [], archiveRows = null }) {
  const videosSheet = statSheet([VROWS, ...videoRows]);
  const named = {};
  if (archiveRows !== null) named.Archive = statSheet([VROWS, ...archiveRows]);
  const videosSpreadsheet = { getSheets: () => [videosSheet], getSheetByName: (n) => named[n] || null };
  const byId = { VIDEOS_ID: videosSpreadsheet };
  const globals = {
    SpreadsheetApp: { openById: (id) => byId[id] || { getSheets: () => [statSheet([['key', 'value']])], getSheetByName: () => null } },
    CacheService: memoryCache(),
    PropertiesService: memoryProps(),
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Logger: { log() {} },
    Utilities: {}, UrlFetchApp: {}, ScriptApp: {},
  };
  const patched = SRC.replace(/VIDEOS:\s*'[^']+'/, "VIDEOS: 'VIDEOS_ID'");
  const names = ['getVideos', 'handleTopWeek', 'handleArchive', 'handleVideo'];
  const factory = new Function(...Object.keys(globals), `${patched}\nreturn { ${names.join(', ')} };`);
  return { ...factory(...Object.values(globals)), videosSheet };
}

describe('BE11 — read-handler clamps', () => {
  const now = Date.now();

  it('getVideos caps an oversized limit at 100', () => {
    const be = loadReads({ videoRows: manyVideos(140, now) });
    const res = be.getVideos(1, 100000, '');
    expect(res.status).toBe('ok');
    expect(res.total).toBe(140);
    expect(res.videos).toHaveLength(100); // capped, not 140
  });

  it('handleTopWeek clamps a negative page to the first window', () => {
    const be = loadReads({ videoRows: manyVideos(3, now) });
    const res = be.handleTopWeek({ page: -5, limit: 2 });
    expect(res.status).toBe('ok');
    expect(res.total).toBe(3);
    // page clamps to 1 -> a real first-page window, never a slice(-100,-50) from the end
    expect(res.videos).toHaveLength(2);
    expect(res.videos.length).toBeLessThanOrEqual(res.total);
  });

  it('handleTopWeek caps an oversized limit at 100', () => {
    const be = loadReads({ videoRows: manyVideos(130, now) });
    const res = be.handleTopWeek({ page: 1, limit: 100000 });
    expect(res.total).toBe(130);
    expect(res.videos).toHaveLength(100);
  });

  it('handleArchive clamps a negative page and caps an oversized limit', () => {
    const be = loadReads({ videoRows: [], archiveRows: manyVideos(130, now) });
    const neg = be.handleArchive({ page: -1, limit: 2 });
    expect(neg.status).toBe('ok');
    expect(neg.videos).toHaveLength(2); // clamped to page 1, not an empty negative slice

    const big = be.handleArchive({ page: 1, limit: 100000 });
    expect(big.total).toBe(130);
    expect(big.videos).toHaveLength(100);
  });
});

describe('BE11 — handleVideo not-found marker', () => {
  const now = Date.now();

  it('short-circuits a repeat lookup of a bogus id without re-scanning the live sheet', () => {
    const be = loadReads({
      videoRows: [['LIVEVIDEO01', 'A', 't', 'https://x/1', iso(now - 60000), 0, 0, 'video', '']],
      archiveRows: [['ARCHVIDEO01', 'B', 'old', 'https://x/2', iso(now - 9999999), 0, 0, 'video', '']],
    });

    const first = be.handleVideo({ videoId: 'NOSUCHVID01' });
    expect(first).toEqual({ status: 'ok', video: null });
    const readsAfterFirst = be.videosSheet._stats.reads;
    expect(readsAfterFirst).toBeGreaterThan(0); // the first miss DID scan the live sheet

    const second = be.handleVideo({ videoId: 'NOSUCHVID01' });
    expect(second).toEqual({ status: 'ok', video: null });
    // The marker answered without touching the live sheet again.
    expect(be.videosSheet._stats.reads).toBe(readsAfterFirst);
  });

  it('does not mask a real video (marker is only set on a genuine miss)', () => {
    const be = loadReads({
      videoRows: [['LIVEVIDEO01', 'A', 't', 'https://x/1', iso(now - 60000), 0, 7, 'video', '']],
    });
    const res = be.handleVideo({ videoId: 'LIVEVIDEO01' });
    expect(res.status).toBe('ok');
    expect(res.video).toMatchObject({ video_id: 'LIVEVIDEO01', vote_count: 7 });
  });
});

// ==================================================================
// SEC5 — clientError per-session budget + Meta kill switch
// ==================================================================

function metaSheet(rows) {
  const grid = rows.map((r) => r.slice());
  return {
    _grid: grid,
    getLastRow: () => grid.length,
    appendRow: (r) => { grid.push(r.slice()); },
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getRange: () => ({ setNumberFormat() {}, setValue() {}, setValues() {} }),
  };
}

function loadClientError(sheet, cache) {
  const globals = {
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{}' }) },
    SpreadsheetApp: { openById: () => ({ getSheets: () => [sheet], getSheetByName: () => sheet, insertSheet: () => sheet }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: cache || memoryCache(),
    PropertiesService: memoryProps(),
    Utilities: { getUuid: () => 'uuid', sleep() {}, computeDigest: () => [], base64EncodeWebSafe: () => 'x', DigestAlgorithm: { SHA_256: 'SHA_256', MD5: 'MD5' } },
    Logger: { log() {} },
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
    ScriptApp: {}, XmlService: {},
  };
  const factory = new Function(...Object.keys(globals), `${SRC}\nreturn { handleClientError };`);
  return factory(...Object.values(globals)).handleClientError;
}

const errReport = (over = {}) => ({
  sessionId: 's_abc12345', appVersion: '1.0.0', page: 'https://x/#latest', userAgent: 'UA/1.0',
  errors: [{ ts: 't', message: 'boom', stack: '', source: 's' }],
  ...over,
});

const NOW = 1755680400000;
const MINUTE = Math.floor(NOW / 60000);

afterEach(() => vi.restoreAllMocks());

describe('SEC5 — clientError per-session budget', () => {
  it('drops a session that has spent its per-session budget, while another session still reports', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    // s_flood already at its per-session cap (20); the GLOBAL budget is untouched.
    const cache = memoryCache({ ['cerr_s_s_flood_' + MINUTE]: '20' });
    const handleClientError = loadClientError(metaSheet([['key', 'value']]), cache);

    const flood = handleClientError(errReport({ sessionId: 's_flood' }));
    expect(flood).toMatchObject({ status: 'ok', accepted: 0, dropped: 1 });

    // A different session is unaffected — one abuser can't starve everyone.
    const other = handleClientError(errReport({ sessionId: 's_other' }));
    expect(other.accepted).toBe(1);
  });

  it('still enforces the global budget across sessions', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const cache = memoryCache({ ['cerr_' + MINUTE]: '60' }); // global spent
    const handleClientError = loadClientError(metaSheet([['key', 'value']]), cache);
    const res = handleClientError(errReport({ sessionId: 's_fresh' }));
    expect(res).toMatchObject({ status: 'ok', accepted: 0, dropped: 1 });
  });
});

describe('SEC5 — clientError Meta kill switch', () => {
  it('drops everything when the kill-switch Meta key is set', () => {
    const sheet = metaSheet([['key', 'value'], ['client_error_disabled', 'true']]);
    const handleClientError = loadClientError(sheet);
    const res = handleClientError(errReport());
    expect(res).toMatchObject({ status: 'ok', accepted: 0, dropped: 1 });
  });

  it('accepts normally when the kill switch is absent/falsey', () => {
    const sheet = metaSheet([['key', 'value']]);
    const handleClientError = loadClientError(sheet);
    const res = handleClientError(errReport());
    expect(res.accepted).toBe(1);
  });
});
