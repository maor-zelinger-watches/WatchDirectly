/**
 * Executable tests for the Meta `log_level` threshold in the REAL
 * apps-script/Code.gs `log()`, against an in-memory LOGS sheet.
 *
 * The contract: `log_level` names the LOWEST severity that gets written, so
 * DEBUG writes everything, WARN writes WARN+ERROR only, and an unset or
 * unrecognized value falls back to ERROR-only.
 *
 * Regression guarded: LOG_LEVELS.DEBUG is 0, so the old
 * `LOG_LEVELS[configLevel] || LOG_LEVELS.ERROR` treated a configured DEBUG as
 * falsy and silently filtered at ERROR — setting log_level=DEBUG produced no
 * DEBUG or INFO line at all, making every log('DEBUG', ...) in the crawl dead
 * code in exactly the configuration meant to surface it. Presence of the key,
 * not its truthiness, picks the threshold.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');
const idOf = (key) => SRC.match(new RegExp(key + ":\\s*'([^']+)'"))[1];
const IDS = { META: idOf('META'), LOGS: idOf('LOGS') };

/** Minimal sheet: header + rows, with just the range API log()/loadMeta touch. */
function gridSheet(rows, name) {
  const grid = rows.map((r) => r.slice());
  return {
    _grid: grid,
    getName: () => name,
    getLastRow: () => grid.length,
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    appendRow: (r) => { grid.push(r.slice()); },
  };
}

/**
 * Loads Code.gs with a Meta sheet holding `logLevel` (omit for no log_level
 * row at all — the unset case) and an empty LOGS sheet.
 * Returns the exported log()/getLogLevel() plus the captured log rows.
 */
function load(logLevel) {
  const metaRows = [['key', 'value']];
  if (logLevel !== undefined) metaRows.push(['log_level', logLevel]);
  const meta = gridSheet(metaRows, 'Meta');
  const logs = gridSheet([['timestamp', 'level', 'source', 'message']], 'Logs');

  const single = (s) => ({ getSheets: () => [s], getSheetByName: () => null });
  const globals = {
    SpreadsheetApp: { openById: (id) => single(id === IDS.LOGS ? logs : meta) },
    Logger: { log() {} },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {}, deleteProperty() {} }) },
    UrlFetchApp: {}, Utilities: { sleep() {} },
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
    ScriptApp: {}, XmlService: {},
  };
  const names = ['log', 'getLogLevel'];
  const factory = new Function(...Object.keys(globals), `${SRC}\nreturn { ${names.join(', ')} };`);
  const be = factory(...Object.values(globals));
  // Written levels, in order, skipping the header row.
  const written = () => logs._grid.slice(1).map((r) => r[1]);
  return { be, written, logs };
}

/** Emits one line at each severity, low to high. */
function logAllLevels(be) {
  be.log('DEBUG', 'test', 'debug line');
  be.log('INFO', 'test', 'info line');
  be.log('WARN', 'test', 'warn line');
  be.log('ERROR', 'test', 'error line');
}

describe('log_level threshold', () => {
  it('writes a DEBUG line when log_level is DEBUG (the falsy-zero regression)', () => {
    const { be, written } = load('DEBUG');
    expect(be.getLogLevel()).toBe('DEBUG');
    logAllLevels(be);
    expect(written()).toEqual(['DEBUG', 'INFO', 'WARN', 'ERROR']);
  });

  it('keeps the DEBUG message body, not just the level column', () => {
    const { be, logs } = load('DEBUG');
    be.log('DEBUG', 'crawl', 'fetched 3 items');
    const row = logs._grid[1];
    expect(row[1]).toBe('DEBUG');
    expect(row[2]).toBe('crawl');
    expect(row[3]).toBe('fetched 3 items');
  });

  it('drops INFO but writes WARN when log_level is WARN', () => {
    const { be, written } = load('WARN');
    logAllLevels(be);
    expect(written()).toEqual(['WARN', 'ERROR']);
  });

  it('falls back to ERROR-only when log_level is unset', () => {
    const { be, written } = load(); // no log_level row in Meta
    expect(be.getLogLevel()).toBe('ERROR');
    logAllLevels(be);
    expect(written()).toEqual(['ERROR']);
  });

  it('falls back to ERROR-only for a garbage log_level', () => {
    const { be, written } = load('VERBOSE');
    logAllLevels(be);
    expect(written()).toEqual(['ERROR']);
  });

  it('accepts a lowercase log_level (getLogLevel upcases)', () => {
    const { be, written } = load('debug');
    expect(be.getLogLevel()).toBe('DEBUG');
    logAllLevels(be);
    expect(written()).toEqual(['DEBUG', 'INFO', 'WARN', 'ERROR']);
  });
});
