/**
 * Tests for the user-data consolidation: the Votes/Stars/Bookmarks tabs live
 * in the CUSTOMERS spreadsheet (getUserDataTab), legacy rows migrate across
 * from the Comments spreadsheet on first access — idempotently, by id, and
 * all-or-nothing — and getCustomersSheet addresses its tab by NAME, claiming
 * the pre-consolidation unnamed tab without ever grabbing an activity tab.
 *
 * Same eval-the-real-source harness as the other backend tests.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');

const VOTE_HEADERS = ['vote_id', 'video_id', 'user_email', 'created_at'];

function makeSheet(rows, name = '') {
  const grid = rows.map((r) => r.slice());
  return {
    _grid: grid,
    _name: name,
    getName() { return this._name; },
    setName(n) { this._name = n; return this; },
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getRange: (row, col, numRows, numCols) => ({
      setNumberFormat() { return this; },
      setValue(v) {
        while (grid.length < row) grid.push([]);
        const r = grid[row - 1];
        while (r.length < col) r.push('');
        r[col - 1] = v;
      },
      setValues(values) {
        for (let i = 0; i < values.length; i++) {
          while (grid.length < row + i) grid.push([]);
          const r = grid[row - 1 + i];
          for (let j = 0; j < values[i].length; j++) {
            while (r.length < col + j) r.push('');
            r[col - 1 + j] = values[i][j];
          }
        }
        return this;
      },
      clearContent() { return this; },
      getValues: () => {
        const out = [];
        for (let i = 0; i < (numRows || 1); i++) {
          const r = grid[row - 1 + i] || [];
          const line = [];
          for (let j = 0; j < (numCols || 1); j++) line.push(r[col - 1 + j] ?? '');
          out.push(line);
        }
        return out;
      },
    }),
    appendRow: (r) => { grid.push(r.slice()); },
    getLastRow: () => grid.length,
    getLastColumn: () => (grid[0] ? grid[0].length : 0),
  };
}

/** A spreadsheet of named tabs; `first` is tab order for getSheets(). */
function makeSpreadsheet(tabsInOrder) {
  const ss = {
    _tabs: tabsInOrder.slice(),
    getSheets() { return this._tabs.slice(); },
    getSheetByName(name) { return this._tabs.find((t) => t.getName() === name) || null; },
    insertSheet(name) { const s = makeSheet([], name); this._tabs.push(s); return s; },
    deleteSheet(sheet) { this._tabs = this._tabs.filter((t) => t !== sheet); },
  };
  return ss;
}

function load({ customersTabs = [], commentsTabs = [] } = {}) {
  const customersSS = makeSpreadsheet(customersTabs);
  const commentsSS = makeSpreadsheet(commentsTabs);
  const metaSS = makeSpreadsheet([makeSheet([['key', 'value'], ['log_level', 'ERROR']], 'Meta')]);
  const byId = { CUSTOMERS_ID: customersSS, COMMENTS_ID: commentsSS, META_ID: metaSS, LOGS_ID: makeSpreadsheet([makeSheet([[]], 'Logs')]) };

  const globals = {
    SpreadsheetApp: { openById: (id) => byId[id] || makeSpreadsheet([makeSheet([[]], 'blank')]) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    Utilities: { sleep() {}, getUuid: () => 'uuid' },
    Logger: { log() {} },
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
    ScriptApp: {}, UrlFetchApp: {}, XmlService: {},
  };
  const patched = SRC
    .replace(/CUSTOMERS:\s*'[^']+'/, "CUSTOMERS: 'CUSTOMERS_ID'")
    .replace(/COMMENTS:\s*'[^']+'/, "COMMENTS: 'COMMENTS_ID'")
    .replace(/META:\s*'[^']+'/, "META: 'META_ID'")
    .replace(/LOGS:\s*'[^']+'/, "LOGS: 'LOGS_ID'");
  const names = ['getUserDataTab', 'migrateLegacyUserTab', 'getVotesSheet', 'getStarsSheet', 'getBookmarksSheet', 'getCustomersSheet'];
  const factory = new Function(...Object.keys(globals), `${patched}\nreturn { ${names.join(', ')} };`);
  return { ...factory(...Object.values(globals)), customersSS, commentsSS };
}

describe('getUserDataTab — activity tabs live in the CUSTOMERS spreadsheet', () => {
  it('returns the existing tab without touching the legacy spreadsheet', () => {
    const votes = makeSheet([VOTE_HEADERS, ['v1', 'vidA', 'a@x.com', 't']], 'Votes');
    const be = load({ customersTabs: [votes] });
    expect(be.getVotesSheet()).toBe(votes);
    expect(be.commentsSS.getSheets()).toHaveLength(0); // never even opened a tab there
  });

  it('creates a missing tab and migrates the legacy Comments-spreadsheet rows', () => {
    const legacy = makeSheet([VOTE_HEADERS, ['v1', 'vidA', 'a@x.com', 't1'], ['v2', 'vidB', 'b@x.com', 't2']], 'Votes');
    const be = load({ commentsTabs: [legacy] });

    const sheet = be.getVotesSheet();
    expect(be.customersSS.getSheetByName('Votes')).toBe(sheet);
    expect(sheet._grid).toEqual([
      VOTE_HEADERS,
      ['v1', 'vidA', 'a@x.com', 't1'],
      ['v2', 'vidB', 'b@x.com', 't2'],
    ]);
    expect(legacy._grid).toHaveLength(3); // legacy tab left untouched
  });

  it('migration copies by id — rows already in the target are never duplicated', () => {
    const legacy = makeSheet([VOTE_HEADERS, ['v1', 'vidA', 'a@x.com', 't1'], ['v2', 'vidB', 'b@x.com', 't2']], 'Votes');
    const be = load({ commentsTabs: [legacy] });
    // A target that already holds v1 (e.g. a crashed attempt whose rollback
    // itself failed): only v2 may be copied.
    const target = makeSheet([VOTE_HEADERS, ['v1', 'vidA', 'a@x.com', 't1']], 'Votes');

    const copied = be.migrateLegacyUserTab('Votes', target, VOTE_HEADERS);
    expect(copied).toBe(1);
    const ids = target._grid.slice(1).map((r) => r[0]).sort();
    expect(ids).toEqual(['v1', 'v2']); // each id exactly once
  });

  it('a failed migration deletes the half-made tab so the next access retries', () => {
    const legacy = makeSheet([VOTE_HEADERS, ['v1', 'vidA', 'a@x.com', 't1']], 'Votes');
    let boom = true;
    const flaky = {
      ...legacy,
      getName: () => 'Votes',
      getDataRange() {
        if (boom) { boom = false; throw new Error('Sheets hiccup'); }
        return { getValues: () => legacy._grid.map((r) => r.slice()) };
      },
    };
    const be = load({ commentsTabs: [flaky] });

    expect(() => be.getVotesSheet()).toThrow('Sheets hiccup');
    expect(be.customersSS.getSheetByName('Votes')).toBeNull(); // rolled back

    const sheet = be.getVotesSheet(); // retry succeeds and migrates
    expect(sheet._grid).toEqual([VOTE_HEADERS, ['v1', 'vidA', 'a@x.com', 't1']]);
  });

  it('a fresh install (no legacy tab) just creates an empty, headed tab', () => {
    const be = load({});
    const sheet = be.getBookmarksSheet();
    expect(sheet._grid).toEqual([['bookmark_id', 'video_id', 'user_email', 'created_at']]);
  });
});

describe('getCustomersSheet — name-addressed, order-proof', () => {
  it('finds the named Customers tab wherever it sits in the tab order', () => {
    const customers = makeSheet([['email', 'name'], ['a@x.com', 'A']], 'Customers');
    const votes = makeSheet([VOTE_HEADERS], 'Votes');
    const be = load({ customersTabs: [votes, customers] }); // Customers NOT first
    expect(be.getCustomersSheet()).toBe(customers);
  });

  it('claims the pre-consolidation unnamed tab by renaming it', () => {
    const legacyTab = makeSheet([['email', 'name'], ['a@x.com', 'A']], 'Sheet1');
    const be = load({ customersTabs: [legacyTab] });
    const sheet = be.getCustomersSheet();
    expect(sheet).toBe(legacyTab);
    expect(sheet.getName()).toBe('Customers');
    expect(sheet._grid[1]).toEqual(['a@x.com', 'A']); // data intact
  });

  it('never claims an activity tab — creates a fresh tab instead', () => {
    const votes = makeSheet([VOTE_HEADERS], 'Votes');
    const stars = makeSheet([['star_id', 'channel_name', 'user_email', 'created_at']], 'Stars');
    const be = load({ customersTabs: [votes, stars] });
    const sheet = be.getCustomersSheet();
    expect(sheet.getName()).toBe('Customers');
    expect(votes.getName()).toBe('Votes'); // untouched
    expect(stars.getName()).toBe('Stars');
  });
});
