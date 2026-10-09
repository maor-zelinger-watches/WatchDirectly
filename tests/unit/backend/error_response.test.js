/**
 * The request handlers must answer with the generic error JSON even when the
 * Spreadsheet service itself is what failed.
 *
 * Background (Cloud Logging, 2026-10-03..08): every "Failed" doGet row in the
 * Apps Script console had the same stack —
 *   log → getLogLevel → getMeta → loadMeta → getSheet, called from doGet's catch.
 * The handler threw "Too many simultaneous invocations: Spreadsheets", the
 * catch block called log(), log() opened the Meta sheet to read log_level, the
 * Spreadsheet service threw AGAIN, and that second throw escaped doGet. The
 * execution died as "Failed" and the client got Google's HTML error page in
 * place of the `{status:'error'}` JSON it can retry on.
 *
 * These tests eval the REAL Code.gs against a SpreadsheetApp whose every open
 * throws, and assert that doGet/doPost still return the JSON response and that
 * log() itself never throws.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');

const SHEETS_DOWN = 'Too many simultaneous invocations: Spreadsheets';

/** Loads Code.gs with a Spreadsheet service that rejects every open. */
function loadWithSheetsDown() {
  const responses = [];
  const opens = { count: 0 };
  const globals = {
    SpreadsheetApp: { openById: () => { opens.count++; throw new Error(SHEETS_DOWN); } },
    Logger: { log() {} },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {}, deleteProperty() {} }) },
    UrlFetchApp: {},
    Utilities: {
      sleep() {}, getUuid: () => 'uuid',
      computeDigest: () => [], base64EncodeWebSafe: () => 'x',
      DigestAlgorithm: { MD5: 'MD5', SHA_256: 'SHA_256' },
    },
    ContentService: {
      createTextOutput: (text) => {
        const out = { text, mime: null, setMimeType(m) { out.mime = m; return out; } };
        responses.push(out);
        return out;
      },
      MimeType: { JSON: 'json' },
    },
    ScriptApp: {}, XmlService: {},
  };
  const names = ['doGet', 'doPost', 'log', 'getLogLevel'];
  const factory = new Function(...Object.keys(globals), `${SRC}\nreturn { ${names.join(', ')} };`);
  const be = factory(...Object.values(globals));
  return { be, responses, opens };
}

const bodyOf = (out) => JSON.parse(out.text);

describe('request handlers answer even when the Spreadsheet service is what failed', () => {
  it('doGet returns the generic error JSON instead of dying in its own catch block', () => {
    const { be, responses, opens } = loadWithSheetsDown();

    let out;
    expect(() => { out = be.doGet({ parameter: { action: 'feed' } }); }).not.toThrow();

    expect(responses).toHaveLength(1);
    expect(out).toBe(responses[0]);
    expect(out.mime).toBe('json');
    expect(bodyOf(out)).toMatchObject({ status: 'error', message: 'Request failed. Please try again.' });
    expect(opens.count).toBeGreaterThan(0); // the handler really did hit the sheet and fail
  });

  it('doGet does the same for every sheet-backed action', () => {
    for (const action of ['feed', 'topWeek', 'archive', 'video', 'getChannels', 'comments']) {
      const { be } = loadWithSheetsDown();
      const out = be.doGet({ parameter: { action, videoId: 'x', page: '1' } });
      expect(bodyOf(out).status, action).toBe('error');
    }
  });

  it('doPost returns the generic error JSON instead of dying in its own catch block', () => {
    const { be, responses } = loadWithSheetsDown();

    let out;
    expect(() => {
      out = be.doPost({ postData: { contents: JSON.stringify({ action: 'logs', token: 'nope' }) } });
    }).not.toThrow();

    expect(responses).toHaveLength(1);
    expect(bodyOf(out).status).toBe('error');
  });

  it('log() never throws, even when reading the log_level itself fails', () => {
    const { be } = loadWithSheetsDown();
    expect(() => be.getLogLevel()).toThrow(SHEETS_DOWN); // the underlying read does fail…
    expect(() => be.log('ERROR', 'test', 'boom')).not.toThrow(); // …but the logger absorbs it
    expect(() => be.log('DEBUG', 'test', 'quiet')).not.toThrow();
  });

  it('with log_level unreadable, the logger still tries to write ERROR lines (fallback is ERROR-only)', () => {
    const { be, opens } = loadWithSheetsDown();
    const before = opens.count;
    be.log('DEBUG', 'test', 'filtered'); // below the ERROR fallback → no LOGS open attempted
    const afterDebug = opens.count;
    be.log('ERROR', 'test', 'written');  // at the fallback → one LOGS open attempted (and absorbed)
    const afterError = opens.count;
    // Each log() call costs one Meta open attempt (the threshold read); only the
    // ERROR line additionally attempts the LOGS sheet.
    expect(afterDebug - before).toBe(1);
    expect(afterError - afterDebug).toBe(2);
  });
});
