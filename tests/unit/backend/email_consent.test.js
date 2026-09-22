/**
 * Backend tests for the email-consent machinery: the CUSTOMERS sheet header
 * normalization, handleEmailConsent, and the bootstrap's marketing_consent
 * (which also lists every signed-in account on first sighting).
 *
 * Same eval-the-real-source harness as handlers.test.js / bookmarks.test.js.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');
const CLIENT_ID = SRC.match(/GOOGLE_CLIENT_ID\s*=\s*'([^']+)'/)[1];
const nowSec = () => Math.floor(Date.now() / 1000);

const CANON = ['email', 'name', 'marketing_consent', 'consent_updated_at', 'first_seen_at', 'source'];

/**
 * An in-memory sheet with a live grid: getRange writes update the grid so a
 * later read (customerCols after ensureCustomerHeaders) sees them. Records
 * formats and cleared ranges for assertions.
 */
function liveSheet(rows) {
  const grid = rows.map((r) => r.slice());
  const formats = [];
  const cleared = [];
  const width = () => grid.reduce((w, r) => Math.max(w, r.length), 0);
  const ensureCell = (row, col) => {
    while (grid.length < row) grid.push([]);
    const r = grid[row - 1];
    while (r.length < col) r.push('');
  };
  return {
    _grid: grid,
    _formats: formats,
    _cleared: cleared,
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getLastRow: () => grid.length,
    getLastColumn: width,
    getRange: (row, col, numRows = 1, numCols = 1) => ({
      getValues: () => {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const src = grid[row - 1 + r] || [];
          const line = [];
          for (let c = 0; c < numCols; c++) line.push(src[col - 1 + c] != null ? src[col - 1 + c] : '');
          out.push(line);
        }
        return out;
      },
      setNumberFormat(fmt) { formats.push({ row, col, numRows, numCols, fmt }); return this; },
      setValue(v) { ensureCell(row, col); grid[row - 1][col - 1] = v; return this; },
      setValues(values) {
        for (let r = 0; r < values.length; r++) {
          for (let c = 0; c < values[r].length; c++) {
            ensureCell(row + r, col + c);
            grid[row - 1 + r][col - 1 + c] = values[r][c];
          }
        }
        return this;
      },
      clearContent() {
        cleared.push({ row, col, numRows, numCols });
        for (let r = 0; r < numRows; r++) {
          for (let c = 0; c < numCols; c++) {
            if (grid[row - 1 + r]) grid[row - 1 + r][col - 1 + c] = '';
          }
        }
        return this;
      },
    }),
    appendRow: (r) => { grid.push(r.slice()); },
  };
}

const CUSTOMERS_ID = SRC.match(/CUSTOMERS:\s*'([^']+)'/)[1];

/**
 * Routes openById by spreadsheet id: the CUSTOMERS id resolves to the
 * customers sheet under test, every other spreadsheet (BLOCKED, META,
 * COMMENTS with its Votes/Stars/Bookmarks tabs, …) to a shared blank
 * sheet — so the customers grid can never double as the block list.
 */
function spreadsheetApp(customers, blank) {
  const wrap = (first) => ({
    getSheets: () => [first],
    getSheetByName: () => blank,
    insertSheet: () => blank,
  });
  return { openById: (id) => wrap(id === CUSTOMERS_ID ? customers : blank) };
}

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

function loadBackend(mocks = {}) {
  const customers = mocks.customers || liveSheet([[]]);
  const globals = {
    UrlFetchApp: mocks.UrlFetchApp || { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{}' }) },
    SpreadsheetApp: spreadsheetApp(customers, liveSheet([[]])),
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
  const names = ['ensureCustomerHeaders', 'handleEmailConsent', 'handleBootstrap', 'readOrCreateCustomer'];
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

/** Backend wired so the CUSTOMERS spreadsheet resolves to `customers`. */
function setup(customers) {
  const be = loadBackend({
    customers,
    UrlFetchApp: tokeninfo(validClaims()),
  });
  return { be, customers };
}

describe('ensureCustomerHeaders (the "check the titles" normalizer)', () => {
  it('writes the canonical header row into an empty sheet', () => {
    const { be, customers } = setup(liveSheet([[]]));
    be.readOrCreateCustomer('user@example.com', 'User'); // touches the sheet
    expect(customers._grid[0]).toEqual(CANON);
  });

  it('replaces operator-typed titles when only a header row exists', () => {
    const { be, customers } = setup(liveSheet([['Email', 'Customer Name', 'Newsletter?']]));
    be.readOrCreateCustomer('user@example.com', 'User');
    expect(customers._grid[0]).toEqual(CANON);
  });

  it('with data rows present, renames known aliases in place and appends the missing columns', () => {
    const sheet = liveSheet([
      ['Email', 'Full Name', 'Consent'],
      ['old@example.com', 'Old Row', 'yes'],
    ]);
    const { be, customers } = setup(sheet);
    be.readOrCreateCustomer('user@example.com', 'User');

    const headers = customers._grid[0];
    expect(headers.slice(0, 3)).toEqual(['email', 'name', 'marketing_consent']); // renamed in place
    for (const h of CANON) expect(headers).toContain(h);                          // rest appended
    expect(customers._grid[1][0]).toBe('old@example.com');                        // data untouched
  });
});

describe('handleEmailConsent', () => {
  it("records an explicit yes as an '@'-formatted row with a timestamp", () => {
    const { be, customers } = setup(liveSheet([CANON.slice()]));
    const res = be.handleEmailConsent({ consent: true, token: 't' });

    expect(res.status).toBe('ok');
    expect(res.marketing_consent).toBe('yes');
    const row = customers._grid[1];
    expect(row[0]).toBe('user@example.com');
    expect(row[2]).toBe('yes');
    expect(row[3]).toMatch(/^\d{4}-\d{2}-\d{2}T/); // consent_updated_at is the compliance record
    expect(row[5]).toBe('consent_prompt');
    expect(customers._formats.some(f => f.fmt === '@')).toBe(true);
  });

  it('flips an existing row to no with a fresh timestamp, adding no second row', () => {
    const { be, customers } = setup(liveSheet([
      CANON.slice(),
      ['user@example.com', 'User', 'yes', '2026-09-01T00:00:00Z', '2026-08-01T00:00:00Z', 'consent_prompt'],
    ]));
    const res = be.handleEmailConsent({ consent: false, token: 't' });

    expect(res.marketing_consent).toBe('no');
    expect(customers._grid.length).toBe(2);
    expect(customers._grid[1][2]).toBe('no');
    expect(customers._grid[1][3] > '2026-09-01T00:00:00Z').toBe(true);
  });

  it('rejects a non-boolean consent and a missing/invalid token', () => {
    const { be } = setup(liveSheet([CANON.slice()]));
    expect(be.handleEmailConsent({ consent: 'yes', token: 't' }).status).toBe('error');
    expect(be.handleEmailConsent({ consent: true }).status).toBe('error');

    const bad = loadBackend({
      customers: liveSheet([CANON.slice()]),
      UrlFetchApp: tokeninfo({ ...validClaims(), aud: 'attacker' }),
    });
    expect(bad.handleEmailConsent({ consent: true, token: 't' }).status).toBe('error');
  });
});

describe('bootstrap consent (every signed-in email gets listed)', () => {
  it("first sighting: inserts the account with blank consent and answers null", () => {
    const { be, customers } = setup(liveSheet([CANON.slice()]));
    const res = be.handleBootstrap({ token: 't' });

    expect(res.status).toBe('ok');
    expect(res.marketing_consent).toBe(null);
    const row = customers._grid[1];
    expect(row[0]).toBe('user@example.com');
    expect(row[1]).toBe('User');
    expect(row[2]).toBe('');                        // never answered ≠ no
    expect(row[4]).toMatch(/^\d{4}-\d{2}-\d{2}T/);  // first_seen_at
    expect(row[5]).toBe('google_signin');
  });

  it('an unreachable CUSTOMERS sheet degrades: bootstrap still serves, key omitted', () => {
    const throwing = {
      get getDataRange() { throw new Error('You do not have permission'); },
      getLastRow: () => { throw new Error('You do not have permission'); },
      getLastColumn: () => { throw new Error('You do not have permission'); },
    };
    const be = loadBackend({ customers: throwing, UrlFetchApp: tokeninfo(validClaims()) });
    const res = be.handleBootstrap({ token: 't' });
    expect(res.status).toBe('ok');
    expect(res.video_ids).toEqual([]);                 // the rest still reconciles
    expect('marketing_consent' in res && res.marketing_consent !== undefined).toBe(false);
    // …and the serialized payload (what the client sees) omits the key entirely.
    expect(JSON.parse(JSON.stringify(res))).not.toHaveProperty('marketing_consent');
  });

  it('a returning consented account reads back its answer without a second row', () => {
    const { be, customers } = setup(liveSheet([
      CANON.slice(),
      ['user@example.com', 'User', 'yes', '2026-09-01T00:00:00Z', '2026-08-01T00:00:00Z', 'consent_prompt'],
    ]));
    const res = be.handleBootstrap({ token: 't' });
    expect(res.marketing_consent).toBe('yes');
    expect(customers._grid.length).toBe(2);
  });
});
