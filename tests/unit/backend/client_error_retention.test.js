/**
 * pruneOldClientErrors — the CLIENT_ERRORS sheet's retention, against the
 * shipped Code.gs. Rows are appended in logged_at order, so expired rows are a
 * contiguous prefix under the header: the prune deletes exactly that prefix
 * in one deleteRows call, stops at the first unexpired or undateable row, and
 * never throws (a busy lock or a sheet error just returns 0).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const HEADERS = ['logged_at', 'client_ts', 'session_id', 'app_version', 'message', 'stack', 'source', 'page', 'user_agent'];
const row = (loggedAt, msg) => [loggedAt, '', 's_x', '1.0.0', msg, '', 'window.onerror', 'https://x/', 'UA'];

function makeSheet(rows) {
  const grid = rows.map((r) => r.slice());
  const calls = { deleteRows: [] };
  return {
    _grid: grid, _calls: calls,
    getLastRow: () => grid.length,
    getLastColumn: () => grid.reduce((m, r) => Math.max(m, r.length), 0),
    getRange: (r, c, nr = 1, nc = 1) => ({
      getValues: () => Array.from({ length: nr }, (_, i) =>
        Array.from({ length: nc }, (_, j) => (grid[r - 1 + i] || [])[c - 1 + j] ?? '')),
      setValues() {}, setNumberFormat() {},
    }),
    deleteRows: (pos, n) => { calls.deleteRows.push([pos, n]); grid.splice(pos - 1, n); },
    appendRow: (r) => grid.push(r.slice()),
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
  };
}

function load(errorRows, { lockBusy = false } = {}) {
  const errors = makeSheet(errorRows);
  const spreadsheets = {
    ERR_ID: { getSheets: () => [errors] },
    META_ID: { getSheets: () => [makeSheet([['key', 'value']])] },
    LOGS_ID: { getSheets: () => [makeSheet([['ts', 'level', 'source', 'message']])] },
  };
  const globals = {
    SpreadsheetApp: { openById: (id) => spreadsheets[id] },
    LockService: { getScriptLock: () => ({
      waitLock() { if (lockBusy) throw new Error('busy'); },
      releaseLock() {},
    }) },
    Logger: { log() {} },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    Utilities: { sleep() {} }, UrlFetchApp: {}, ScriptApp: {},
  };
  const patched = SRC
    .replace(/CLIENT_ERRORS:\s*'[^']+'/, "CLIENT_ERRORS: 'ERR_ID'")
    .replace(/META:\s*'[^']+'/, "META: 'META_ID'")
    .replace(/LOGS:\s*'[^']+'/, "LOGS: 'LOGS_ID'");
  const factory = new Function(...Object.keys(globals),
    `${patched}\nreturn { pruneOldClientErrors, CLIENT_ERROR_RETENTION_DAYS };`);
  return { ...factory(...Object.values(globals)), errors };
}

describe('pruneOldClientErrors', () => {
  it('deletes exactly the expired prefix in one deleteRows call and keeps the rest', () => {
    const now = Date.now();
    const be = load([
      HEADERS,
      row(iso(now - 45 * DAY), 'old-1'),
      row(iso(now - 31 * DAY), 'old-2'),
      row(iso(now - 29 * DAY), 'fresh-1'),
      row(iso(now - 1 * DAY), 'fresh-2'),
    ]);
    expect(be.CLIENT_ERROR_RETENTION_DAYS).toBe(30);
    expect(be.pruneOldClientErrors()).toBe(2);
    expect(be.errors._calls.deleteRows).toEqual([[2, 2]]);
    expect(be.errors._grid.map((r) => r[4])).toEqual(['message', 'fresh-1', 'fresh-2']);
  });

  it('returns 0 and touches nothing when no row is expired, or the sheet is empty', () => {
    const now = Date.now();
    const be = load([HEADERS, row(iso(now - 2 * DAY), 'fresh')]);
    expect(be.pruneOldClientErrors()).toBe(0);
    expect(be.errors._calls.deleteRows).toEqual([]);
    expect(load([HEADERS]).pruneOldClientErrors()).toBe(0);
    expect(load([]).pruneOldClientErrors()).toBe(0);
  });

  it('stops at an undateable row rather than guessing its age', () => {
    const now = Date.now();
    const be = load([
      HEADERS,
      row(iso(now - 60 * DAY), 'old'),
      row('not-a-date', 'odd'),
      row(iso(now - 60 * DAY), 'old-after-odd'),
    ]);
    expect(be.pruneOldClientErrors()).toBe(1);
    expect(be.errors._grid.map((r) => r[4])).toEqual(['message', 'odd', 'old-after-odd']);
  });

  it('is a no-op without a logged_at column', () => {
    const be = load([['message'], ['x']]);
    expect(be.pruneOldClientErrors()).toBe(0);
  });

  it('returns 0 when the lock is busy, and never throws on a sheet failure', () => {
    const now = Date.now();
    const busy = load([HEADERS, row(iso(now - 60 * DAY), 'old')], { lockBusy: true });
    expect(busy.pruneOldClientErrors()).toBe(0);
    expect(busy.errors._grid.length).toBe(2);

    const broken = load([HEADERS, row(iso(now - 60 * DAY), 'old')]);
    broken.errors.deleteRows = () => { throw new Error('boom'); };
    expect(() => broken.pruneOldClientErrors()).not.toThrow();
    expect(broken.pruneOldClientErrors()).toBe(0);
  });
});
