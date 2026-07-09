/**
 * Unit test for pruneOldVideos (backend retention/archival).
 *
 * pruneOldVideos runs at the end of each crawl and moves videos past the
 * retention window out of the live Videos sheet into an "Archive" tab, so
 * readAllVideos' every-request full scan stays bounded. It's the one writer
 * that rewrites the whole live sheet, so this pins down exactly what it keeps,
 * what it archives, and that nothing is destroyed — against the SHIPPED Code.gs.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

/** A stateful, mutable in-memory sheet backed by a 2-D array. */
function makeSheet(rows) {
  const grid = rows.map((r) => r.slice());
  return {
    _grid: grid,
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getRange: (row, col, numRows, numCols) => ({
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
      },
      clearContent() {
        const nr = numRows || 1;
        const nc = numCols || 1;
        for (let i = 0; i < nr; i++) {
          const r = grid[row - 1 + i];
          if (!r) continue;
          for (let j = 0; j < nc; j++) if (col - 1 + j < r.length) r[col - 1 + j] = '';
        }
      },
      setNumberFormat() {},
    }),
    appendRow: (r) => { grid.push(r.slice()); },
    getLastRow: () => grid.length,
    getLastColumn: () => grid.reduce((m, r) => Math.max(m, r.length), 0),
    deleteRows: (rowPosition, howMany) => { grid.splice(rowPosition - 1, howMany); },
  };
}

/** A spreadsheet with a default first sheet plus named tabs (Archive). */
function makeSpreadsheet(firstSheet) {
  const tabs = {};
  return {
    _tabs: tabs,
    getSheets: () => [firstSheet],
    getSheetByName: (name) => tabs[name] || null,
    insertSheet: (name) => { tabs[name] = makeSheet([]); return tabs[name]; },
  };
}

const HEADERS = ['video_id', 'channel_name', 'title', 'url', 'published_at', 'live_status', 'scheduled_start', 'expires_at'];

/** Loads pruneOldVideos + readAllVideos bound to a stateful Videos spreadsheet. */
function loadPrune(videoRows) {
  const videos = makeSheet([HEADERS, ...videoRows]);
  const videosSpreadsheet = makeSpreadsheet(videos);
  const meta = makeSheet([['key', 'value']]); // empty -> log level defaults to ERROR
  const spreadsheets = {
    VIDEOS_ID: videosSpreadsheet,
    META_ID: makeSpreadsheet(meta),
    LOGS_ID: makeSpreadsheet(makeSheet([['ts', 'level', 'source', 'message']])),
  };

  const globals = {
    SpreadsheetApp: { openById: (id) => spreadsheets[id] },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Logger: { log() {} },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    Utilities: { sleep() {} },
    UrlFetchApp: {},
    ScriptApp: {},
  };

  const patched = SRC
    .replace(/VIDEOS:\s*'[^']+'/, "VIDEOS: 'VIDEOS_ID'")
    .replace(/META:\s*'[^']+'/, "META: 'META_ID'")
    .replace(/LOGS:\s*'[^']+'/, "LOGS: 'LOGS_ID'");

  const names = ['pruneOldVideos', 'readAllVideos'];
  const factory = new Function(...Object.keys(globals), `${patched}\nreturn { ${names.join(', ')} };`);
  return { ...factory(...Object.values(globals)), videos, videosSpreadsheet };
}

describe('pruneOldVideos', () => {
  it('archives only rows past the window, keeping recent/undateable/pending-live rows', () => {
    const now = Date.now();
    const rows = [
      // id, channel, title, url, published_at, live_status, scheduled_start, expires_at
      ['RECENT00001', 'A', 't', 'https://x/1', iso(now - 3 * DAY), 'none', '', ''],           // keep: recent
      ['OLDNORMAL01', 'A', 't', 'https://x/2', iso(now - 90 * DAY), 'none', '', ''],           // ARCHIVE: old
      ['OLDUPCOMIN', 'A', 't', 'https://x/3', iso(now - 90 * DAY), 'upcoming', '', ''],        // keep: pending live
      ['OLDUNEXPIR', 'A', 't', 'https://x/4', iso(now - 90 * DAY), 'none', '', iso(now + DAY)],// keep: unexpired grace
      ['BADDATEROW', 'A', 't', 'https://x/5', 'not-a-date', 'none', '', ''],                   // keep: undateable
    ];
    const be = loadPrune(rows);

    const archived = be.pruneOldVideos();
    expect(archived).toBe(1);

    // Live sheet: header + the four survivors, old-normal gone.
    const liveIds = be.videos._grid.slice(1).map((r) => r[0]).filter(Boolean);
    expect(liveIds).toEqual(['RECENT00001', 'OLDUPCOMIN', 'OLDUNEXPIR', 'BADDATEROW']);
    expect(liveIds).not.toContain('OLDNORMAL01');

    // Nothing destroyed — the archived row lives in the Archive tab (with header).
    const archive = be.videosSpreadsheet._tabs.Archive;
    expect(archive).toBeTruthy();
    expect(archive._grid[0]).toEqual(HEADERS);
    expect(archive._grid.slice(1).map((r) => r[0])).toEqual(['OLDNORMAL01']);

    // readAllVideos now sees exactly the survivors (minus dedupe/expiry, n/a here).
    expect(be.readAllVideos().map((v) => v.video_id).sort())
      .toEqual(['BADDATEROW', 'OLDUNEXPIR', 'OLDUPCOMIN', 'RECENT00001'].sort());
  });

  it('is a no-op (no Archive tab) when nothing is old enough', () => {
    const now = Date.now();
    const be = loadPrune([
      ['RECENT00001', 'A', 't', 'https://x/1', iso(now - 1 * DAY), 'none', '', ''],
      ['RECENT00002', 'A', 't', 'https://x/2', iso(now - 10 * DAY), 'none', '', ''],
    ]);
    expect(be.pruneOldVideos()).toBe(0);
    expect(be.videosSpreadsheet._tabs.Archive).toBeUndefined();
    expect(be.videos._grid.slice(1).map((r) => r[0])).toEqual(['RECENT00001', 'RECENT00002']);
  });
});
