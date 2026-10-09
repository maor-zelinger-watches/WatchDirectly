/**
 * Backend tests for the `feedback` action — the floating button's
 * submissions, filed in the Feedback tab of the CUSTOMERS spreadsheet.
 *
 * Signed-in only: a missing or bad token is an error and nothing is written.
 * Pinned as requirements: the message cap (rejected, not clipped), the
 * per-sender spacing, the block list, and the '@' plain-text format landing
 * before the values. Same eval-the-real-source harness as the other backend
 * tests.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');
const CLIENT_ID = SRC.match(/GOOGLE_CLIENT_ID\s*=\s*'([^']+)'/)[1];
const nowSec = () => Math.floor(Date.now() / 1000);

const HEADERS = ['feedback_id', 'created_at', 'email', 'name', 'message', 'page', 'app_version', 'user_agent'];

/** In-memory tab that records the ORDER of range calls (format before values). */
function makeSheet(rows, name = '') {
  const grid = rows.map((r) => r.slice());
  const calls = [];
  return {
    _grid: grid,
    _calls: calls,
    _name: name,
    getName() { return this._name; },
    setName(n) { this._name = n; return this; },
    getLastRow: () => grid.length,
    getLastColumn: () => (grid[0] ? grid[0].length : 0),
    appendRow: (row) => { grid.push(row.slice()); calls.push(['appendRow', row.slice()]); },
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getRange: (row, col, numRows = 1, numCols = 1) => ({
      getValues: () => [[]],
      setNumberFormat(fmt) { calls.push(['setNumberFormat', fmt, row, numRows, numCols]); return this; },
      setValue() { return this; },
      setValues(values) {
        calls.push(['setValues', row, values.length]);
        for (let i = 0; i < values.length; i++) grid[row - 1 + i] = values[i].slice();
        return this;
      },
      clearContent() { return this; },
    }),
  };
}

function makeSpreadsheet(tabs) {
  return {
    _tabs: tabs.slice(),
    getSheets() { return this._tabs.slice(); },
    getSheetByName(name) { return this._tabs.find((t) => t.getName() === name) || null; },
    insertSheet(name) { const s = makeSheet([], name); this._tabs.push(s); return s; },
    deleteSheet(sheet) { this._tabs = this._tabs.filter((t) => t !== sheet); },
  };
}

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

function tokeninfo(payload, code = 200) {
  return { fetch: () => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(payload) }) };
}

const validClaims = () => ({
  aud: CLIENT_ID, iss: 'accounts.google.com', exp: nowSec() + 3600,
  email: 'user@example.com', email_verified: 'true', name: 'User', picture: 'https://x/p.jpg',
});

/**
 * Backend wired so the CUSTOMERS spreadsheet is `customersSS` (its tabs
 * are whatever the test seeds), BLOCKED is `blockedRows`, and every other
 * spreadsheet is a blank sheet.
 */
function load({ customersTabs = [], blockedRows = [['email']], cache = memoryCache(), UrlFetchApp, lockFails = false } = {}) {
  const customersSS = makeSpreadsheet(customersTabs);
  const blockedSS = makeSpreadsheet([makeSheet(blockedRows, 'Blocked')]);
  const byId = { CUSTOMERS_ID: customersSS, BLOCKED_ID: blockedSS };
  const blank = () => makeSpreadsheet([makeSheet([[]], 'blank')]);
  const globals = {
    UrlFetchApp: UrlFetchApp || { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{}' }) },
    SpreadsheetApp: { openById: (id) => byId[id] || blank() },
    LockService: {
      getScriptLock: () => ({
        waitLock() { if (lockFails) throw new Error('Lock timeout'); },
        releaseLock() {},
      }),
    },
    CacheService: cache,
    Utilities: {
      getUuid: () => 'uuid-1',
      computeDigest: () => [], base64EncodeWebSafe: () => 'x', sleep() {},
      DigestAlgorithm: { MD5: 'MD5', SHA_256: 'SHA_256' },
    },
    Logger: { log() {} },
    ContentService: { createTextOutput: (s) => ({ _s: s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    ScriptApp: {}, XmlService: {},
  };
  const patched = SRC
    .replace(/CUSTOMERS:\s*'[^']+'/, "CUSTOMERS: 'CUSTOMERS_ID'")
    .replace(/BLOCKED:\s*'[^']+'/, "BLOCKED: 'BLOCKED_ID'");
  const names = ['handleFeedback', 'getFeedbackSheet', 'getCustomersSheet', 'doPost', 'SIGNED_ACTIONS', 'FEEDBACK_MAX_LENGTH'];
  const factory = new Function(...Object.keys(globals), `${patched}\nreturn { ${names.join(', ')} };`);
  return { ...factory(...Object.values(globals)), customersSS, cache };
}

const feedbackTab = (be) => be.customersSS.getSheetByName('Feedback');

const signedIn = (extra = {}) => load({ UrlFetchApp: tokeninfo(validClaims()), ...extra });

describe('handleFeedback — validation', () => {
  it('requires a non-blank message AND a token', () => {
    const be = signedIn();
    expect(be.handleFeedback({})).toMatchObject({ status: 'error', message: /message and token are required/ });
    expect(be.handleFeedback({ message: '   ', token: 'h.p.s' })).toMatchObject({ status: 'error' });
    expect(be.handleFeedback({ message: 42, token: 'h.p.s' })).toMatchObject({ status: 'error' });
    expect(be.handleFeedback({ message: 'no sender' })).toMatchObject({ status: 'error', message: /token/ });
    expect(feedbackTab(be)).toBe(null); // nothing created for a rejected send
  });

  it('rejects (never clips) a message over the cap', () => {
    const be = signedIn();
    const res = be.handleFeedback({ message: 'x'.repeat(be.FEEDBACK_MAX_LENGTH + 1), token: 'h.p.s' });
    expect(res).toMatchObject({ status: 'error' });
    expect(res.message).toMatch(/too long/i);
    expect(feedbackTab(be)).toBe(null);

    const ok = be.handleFeedback({ message: 'x'.repeat(be.FEEDBACK_MAX_LENGTH), token: 'h.p.s' });
    expect(ok.status).toBe('ok');
  });
});

describe('handleFeedback — writing the row', () => {
  it('creates the Feedback tab with its header row and appends the row under the sender', () => {
    const be = signedIn();
    const res = be.handleFeedback({
      message: '  The Shorts chip hides articles  ',
      token: 'h.p.s',
      page: 'https://www.howyouwatch.com/',
      appVersion: '1.31.0',
      userAgent: 'UA',
    });
    expect(res).toEqual({ status: 'ok', feedback_id: 'uuid-1' });

    const tab = feedbackTab(be);
    expect(tab._grid[0]).toEqual(HEADERS);
    expect(tab._grid[1]).toEqual([
      'uuid-1', expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), 'user@example.com', 'User',
      'The Shorts chip hides articles', 'https://www.howyouwatch.com/', '1.31.0', 'UA',
    ]);
  });

  it("sets '@' plain-text format on the row BEFORE writing the values", () => {
    const be = signedIn();
    be.handleFeedback({ message: '=HYPERLINK("http://evil")', token: 'h.p.s' });
    const calls = feedbackTab(be)._calls;
    const fmt = calls.findIndex((c) => c[0] === 'setNumberFormat' && c[1] === '@');
    const vals = calls.findIndex((c) => c[0] === 'setValues');
    expect(fmt).toBeGreaterThan(-1);
    expect(vals).toBeGreaterThan(fmt);
    expect(feedbackTab(be)._grid[1][4]).toBe('=HYPERLINK("http://evil")'); // stored verbatim, as text
  });

  it('clips the page / app version / user agent fields', () => {
    const be = signedIn();
    be.handleFeedback({ message: 'm', token: 'h.p.s', page: 'p'.repeat(400), appVersion: 'v'.repeat(40), userAgent: 'u'.repeat(400) });
    const row = feedbackTab(be)._grid[1];
    expect(row[5]).toHaveLength(300);
    expect(row[6]).toHaveLength(20);
    expect(row[7]).toHaveLength(300);
  });

  it('appends after existing rows in an existing tab', () => {
    const existing = makeSheet([HEADERS, ['f0', 't', '', '', 'old', '', '', '']], 'Feedback');
    const be = signedIn({ customersTabs: [existing] });
    be.handleFeedback({ message: 'new', token: 'h.p.s' });
    expect(existing._grid).toHaveLength(3);
    expect(existing._grid[2][4]).toBe('new');
  });

  it('fails open on cache trouble (no rate limit, the row still lands)', () => {
    const broken = { getScriptCache: () => { throw new Error('cache down'); } };
    const be = signedIn({ cache: broken });
    expect(be.handleFeedback({ message: 'm', token: 'h.p.s' }).status).toBe('ok');
  });

  it('a lock timeout answers "busy" without writing', () => {
    const be = signedIn({ lockFails: true });
    expect(be.handleFeedback({ message: 'm', token: 'h.p.s' })).toMatchObject({ status: 'error', message: /busy/i });
    expect(feedbackTab(be)).toBe(null);
  });
});

describe('handleFeedback — the sender', () => {
  it('a bad token is an error and nothing is written', () => {
    const be = load({ UrlFetchApp: tokeninfo({ error: 'invalid_token' }, 400) });
    const res = be.handleFeedback({ message: 'hi', token: 'h.p.s' });
    expect(res).toMatchObject({ status: 'error', message: /invalid authentication token/i });
    expect(feedbackTab(be)).toBe(null);
  });

  it('a blocked account is refused', () => {
    const be = signedIn({ blockedRows: [['email'], ['user@example.com']] });
    const res = be.handleFeedback({ message: 'hi', token: 'h.p.s' });
    expect(res).toMatchObject({ status: 'error', message: /blocked/i });
    expect(feedbackTab(be)).toBe(null);
  });

  it('spaces a sender out (second send inside the window is refused)', () => {
    const be = signedIn();
    expect(be.handleFeedback({ message: 'one', token: 'h.p.s' }).status).toBe('ok');
    const res = be.handleFeedback({ message: 'two', token: 'h.p.s' });
    expect(res).toMatchObject({ status: 'error', message: /too fast/i });
    expect(feedbackTab(be)._grid).toHaveLength(2);
  });
});

describe('feedback — wiring', () => {
  it('doPost routes the feedback action', () => {
    const be = signedIn();
    const out = be.doPost({ postData: { contents: JSON.stringify({ action: 'feedback', message: 'via doPost', token: 'h.p.s' }) } });
    expect(JSON.parse(out._s)).toMatchObject({ status: 'ok', feedback_id: 'uuid-1' });
    expect(feedbackTab(be)._grid[1][4]).toBe('via doPost');
  });

  it('feedback is a signed action (the frontend signs every POST)', () => {
    const be = load();
    expect(be.SIGNED_ACTIONS.feedback).toBe(true);
  });

  it('getCustomersSheet never claims the Feedback tab as the Customers tab', () => {
    const feedback = makeSheet([HEADERS], 'Feedback');
    const be = load({ customersTabs: [feedback] });
    const customers = be.getCustomersSheet();
    expect(customers).not.toBe(feedback);
    expect(feedback.getName()).toBe('Feedback');
    expect(customers.getName()).toBe('Customers');
  });
});
