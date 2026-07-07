/**
 * Executable tests for apps-script/Code.gs backend logic.
 *
 * Code.gs targets the Google Apps Script runtime (SpreadsheetApp, UrlFetchApp,
 * LockService, ...), so it cannot be imported. Instead we eval the REAL source
 * inside a function that injects mock globals, then exercise the actual shipped
 * functions — not reimplemented copies (the pre-existing parser.test.js tests a
 * hand-copied slice, which is how the divergent .slice() bug hid). Everything
 * is in-memory: there are no temp files, sheets, or global mutations to clean
 * up, so a failing test leaves nothing behind.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');
const CLIENT_ID = SRC.match(/GOOGLE_CLIENT_ID\s*=\s*'([^']+)'/)[1];
const nowSec = () => Math.floor(Date.now() / 1000);

/** A fake Spreadsheet whose every sheet resolves to `sheet`. */
function spreadsheetReturning(sheet) {
  const ss = { getSheets: () => [sheet], getSheetByName: () => sheet, insertSheet: () => sheet };
  return { openById: () => ss };
}

/** A minimal empty sheet; override any method (e.g. appendRow) as needed. */
function blankSheet(overrides = {}) {
  return {
    getDataRange: () => ({ getValues: () => [[]] }),
    getRange: () => ({ setValue() {}, setValues() {}, setNumberFormat() {} }),
    appendRow: () => {},
    getLastRow: () => 0,
    ...overrides,
  };
}

/** Eval Code.gs with injected mock globals; return the named functions. */
function loadBackend(mocks = {}) {
  const sheet = mocks.sheet || blankSheet();
  const globals = {
    UrlFetchApp: mocks.UrlFetchApp || { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{}' }) },
    SpreadsheetApp: mocks.SpreadsheetApp || spreadsheetReturning(sheet),
    LockService: mocks.LockService || { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: mocks.Utilities || {
      getUuid: () => '00000000-0000-0000-0000-000000000000',
      computeDigest: () => [], base64EncodeWebSafe: () => 'x', sleep() {},
      DigestAlgorithm: { MD5: 'MD5' },
    },
    Logger: { log() {} },
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
    ScriptApp: {}, XmlService: {},
  };
  const names = ['verifyGoogleToken', 'toIsoDate', 'handleAddComment', 'decodeHtmlEntities'];
  const factory = new Function(...Object.keys(globals), `${SRC}\nreturn { ${names.join(', ')} };`);
  return factory(...Object.values(globals));
}

/** A UrlFetchApp mock returning the given tokeninfo payload with HTTP `code`. */
function tokeninfo(payload, code = 200) {
  return { fetch: () => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(payload) }) };
}

const validClaims = () => ({
  aud: CLIENT_ID, iss: 'accounts.google.com', exp: nowSec() + 3600,
  email: 'user@example.com', email_verified: 'true', name: 'User', picture: 'https://x/p.jpg',
});

describe('verifyGoogleToken (finding #1 — token audience)', () => {
  it('accepts a token minted for THIS app', () => {
    const { verifyGoogleToken } = loadBackend({ UrlFetchApp: tokeninfo(validClaims()) });
    expect(verifyGoogleToken('t')).toEqual({ email: 'user@example.com', name: 'User', picture: 'https://x/p.jpg' });
  });

  it('rejects a token minted for a DIFFERENT OAuth client (aud mismatch)', () => {
    const { verifyGoogleToken } = loadBackend({ UrlFetchApp: tokeninfo({ ...validClaims(), aud: 'attacker.apps.googleusercontent.com' }) });
    expect(verifyGoogleToken('t')).toBeNull();
  });

  it('rejects an expired token', () => {
    const { verifyGoogleToken } = loadBackend({ UrlFetchApp: tokeninfo({ ...validClaims(), exp: nowSec() - 10 }) });
    expect(verifyGoogleToken('t')).toBeNull();
  });

  it('rejects an unverified email', () => {
    const { verifyGoogleToken } = loadBackend({ UrlFetchApp: tokeninfo({ ...validClaims(), email_verified: 'false' }) });
    expect(verifyGoogleToken('t')).toBeNull();
  });

  it('rejects a non-Google issuer', () => {
    const { verifyGoogleToken } = loadBackend({ UrlFetchApp: tokeninfo({ ...validClaims(), iss: 'evil.example.com' }) });
    expect(verifyGoogleToken('t')).toBeNull();
  });

  it('rejects when tokeninfo returns non-200', () => {
    const { verifyGoogleToken } = loadBackend({ UrlFetchApp: tokeninfo(validClaims(), 401) });
    expect(verifyGoogleToken('t')).toBeNull();
  });

  it('accepts the https:// issuer variant', () => {
    const { verifyGoogleToken } = loadBackend({ UrlFetchApp: tokeninfo({ ...validClaims(), iss: 'https://accounts.google.com' }) });
    expect(verifyGoogleToken('t')).not.toBeNull();
  });
});

describe('toIsoDate (finding #3 — one bad date must not drop the channel)', () => {
  it('preserves a valid date', () => {
    const { toIsoDate } = loadBackend();
    expect(toIsoDate('2026-01-15T00:00:00Z')).toBe('2026-01-15T00:00:00.000Z');
  });

  it('falls back to a valid ISO string for a malformed date (no throw)', () => {
    const { toIsoDate } = loadBackend();
    expect(() => toIsoDate('Tues, 5 Jul')).not.toThrow();
    expect(toIsoDate('Tues, 5 Jul')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('falls back for an empty date', () => {
    const { toIsoDate } = loadBackend();
    expect(toIsoDate('')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('handleAddComment (finding #4 — append + recount under a lock)', () => {
  function setup(lockThrows = false) {
    const order = [];
    const lock = {
      waitLock: () => { order.push('lock'); if (lockThrows) throw new Error('timeout'); },
      releaseLock: () => order.push('release'),
    };
    // A comment row has exactly 9 columns; meta/rate rows have 2 — so length
    // uniquely identifies the comment append among all appendRow traffic.
    const sheet = blankSheet({
      appendRow: (row) => { if (Array.isArray(row) && row.length === 9) order.push('append'); },
    });
    const be = loadBackend({ UrlFetchApp: tokeninfo(validClaims()), LockService: { getScriptLock: () => lock }, sheet });
    return { be, order };
  }

  it('acquires the lock, appends the comment inside it, then releases', () => {
    const { be, order } = setup();
    const res = be.handleAddComment({ videoId: 'v1', body: 'hi', token: 't' });
    expect(res.status).toBe('ok');
    expect(order).toEqual(['lock', 'append', 'release']);
  });

  it('returns "server busy" and does NOT append when the lock is contended', () => {
    const { be, order } = setup(true);
    const res = be.handleAddComment({ videoId: 'v1', body: 'hi', token: 't' });
    expect(res.status).toBe('error');
    expect(res.message).toMatch(/busy/i);
    expect(order).not.toContain('append');
  });

  it('rejects a comment whose token fails audience verification', () => {
    const order = [];
    const sheet = blankSheet({ appendRow: (row) => { if (row.length === 9) order.push('append'); } });
    const be = loadBackend({ UrlFetchApp: tokeninfo({ ...validClaims(), aud: 'attacker' }), sheet });
    const res = be.handleAddComment({ videoId: 'v1', body: 'hi', token: 't' });
    expect(res.status).toBe('error');
    expect(order).not.toContain('append');
  });
});

describe('decodeHtmlEntities (finding #9 — decode order)', () => {
  it('decodes a double-escaped entity (&amp;#39; -> apostrophe)', () => {
    const { decodeHtmlEntities } = loadBackend();
    expect(decodeHtmlEntities('&amp;#39;')).toBe("'");
  });

  it('decodes a plain numeric entity', () => {
    const { decodeHtmlEntities } = loadBackend();
    expect(decodeHtmlEntities('&#39;')).toBe("'");
  });

  it('decodes a bare &amp;', () => {
    const { decodeHtmlEntities } = loadBackend();
    expect(decodeHtmlEntities('A &amp; B')).toBe('A & B');
  });
});
