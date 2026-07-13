/**
 * Unit test for vote/comment recounts landing on an ARCHIVED video (B5).
 *
 * updateVoteCount / updateCommentCount originally scanned only the live Videos
 * sheet and silently no-oped when the row wasn't there. But shared links
 * (handleVideo) and full-history search (handleArchive) serve archived videos,
 * and the vote/comment handlers don't check where the video lives — so a vote on
 * an archived id was counted in the Votes sheet but never written back to the
 * video's vote_count. This pins the Archive fall-through against the SHIPPED
 * Code.gs.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');

/** A stateful, mutable in-memory sheet backed by a 2-D array. */
function makeSheet(rows) {
  const grid = rows.map((r) => r.slice());
  return {
    _grid: grid,
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getRange: (row, col) => ({
      setValue(v) {
        while (grid.length < row) grid.push([]);
        const r = grid[row - 1];
        while (r.length < col) r.push('');
        r[col - 1] = v;
      },
    }),
    appendRow: (r) => { grid.push(r.slice()); },
    getLastRow: () => grid.length,
  };
}

const V_HEADERS = ['video_id', 'channel_name', 'title', 'url', 'published_at', 'comment_count', 'vote_count', 'media_type'];
const VOTE_HEADERS = ['vote_id', 'video_id', 'user_email', 'created_at'];

/** memory CacheService so the invalidate* helpers have something to remove. */
function makeCache() {
  const store = {};
  return {
    _store: store,
    getScriptCache: () => ({
      get: (k) => (k in store ? store[k] : null),
      put: (k, v) => { store[k] = v; },
      remove: (k) => { delete store[k]; },
    }),
  };
}

function loadBackend({ liveSheet, archiveSheet, votesSheet }) {
  const videosSpreadsheet = {
    getSheets: () => [liveSheet],
    getSheetByName: (n) => (n === 'Archive' ? archiveSheet : null),
  };
  const commentsSpreadsheet = {
    getSheets: () => [makeSheet([[]])],
    getSheetByName: (n) => (n === 'Votes' ? votesSheet : null),
    insertSheet: () => votesSheet,
  };
  const blank = { getSheets: () => [makeSheet([['key', 'value']])], getSheetByName: () => null };
  const byId = { VIDEOS_ID: videosSpreadsheet, COMMENTS_ID: commentsSpreadsheet };

  const globals = {
    SpreadsheetApp: { openById: (id) => byId[id] || blank },
    CacheService: makeCache(),
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Logger: { log() {} },
    Utilities: {}, UrlFetchApp: {}, ScriptApp: {},
  };

  const patched = SRC
    .replace(/VIDEOS:\s*'[^']+'/, "VIDEOS: 'VIDEOS_ID'")
    .replace(/COMMENTS:\s*'[^']+'/, "COMMENTS: 'COMMENTS_ID'");

  const names = ['updateVoteCount', 'updateCommentCount'];
  const factory = new Function(...Object.keys(globals), `${patched}\nreturn { ${names.join(', ')} };`);
  return factory(...Object.values(globals));
}

describe('vote/comment recount on an archived video (B5)', () => {
  it('writes the vote count to the Archive row when the live scan misses', () => {
    const liveSheet = makeSheet([
      V_HEADERS,
      ['LIVEVIDEO01', 'A', 't', 'https://x/1', '2026-07-01', 0, 0, 'video'],
    ]);
    const archiveSheet = makeSheet([
      V_HEADERS,
      ['ARCHIVEDVID', 'B', 'old', 'https://x/2', '2025-01-01', 0, 0, 'video'],
    ]);
    const votesSheet = makeSheet([
      VOTE_HEADERS,
      ['v1', 'ARCHIVEDVID', 'a@x.com', '2026-07-10'],
      ['v2', 'ARCHIVEDVID', 'b@x.com', '2026-07-11'],
    ]);

    const be = loadBackend({ liveSheet, archiveSheet, votesSheet });
    const count = be.updateVoteCount('ARCHIVEDVID');

    expect(count).toBe(2);
    // The live sheet is untouched (the id isn't there)...
    expect(liveSheet._grid[1][V_HEADERS.indexOf('vote_count')]).toBe(0);
    // ...and the archive row now carries the recount.
    const archRow = archiveSheet._grid[1];
    expect(archRow[0]).toBe('ARCHIVEDVID');
    expect(archRow[V_HEADERS.indexOf('vote_count')]).toBe(2);
  });

  it('writes the comment count to the Archive row when the live scan misses', () => {
    const liveSheet = makeSheet([V_HEADERS, ['LIVEVIDEO01', 'A', 't', 'https://x/1', '2026-07-01', 0, 0, 'video']]);
    const archiveSheet = makeSheet([V_HEADERS, ['ARCHIVEDVID', 'B', 'old', 'https://x/2', '2025-01-01', 0, 0, 'video']]);
    const votesSheet = makeSheet([VOTE_HEADERS]);
    // updateCommentCount counts the COMMENTS sheet (getSheets()[0] of the
    // comments spreadsheet); seed it via the commentsSpreadsheet first sheet.
    const be = loadBackendWithComments({ liveSheet, archiveSheet, votesSheet });
    const wrote = be.updateCommentCount('ARCHIVEDVID');
    // updateCommentCount returns undefined; assert via the archive row.
    expect(wrote).toBeUndefined();
    expect(archiveSheet._grid[1][V_HEADERS.indexOf('comment_count')]).toBe(2);
  });
});

/** Variant harness whose comments spreadsheet's first sheet holds 2 comments. */
function loadBackendWithComments({ liveSheet, archiveSheet, votesSheet }) {
  const commentsSheet = makeSheet([
    ['comment_id', 'video_id', 'user_email', 'text', 'created_at'],
    ['c1', 'ARCHIVEDVID', 'a@x.com', 'hi', '2026-07-10'],
    ['c2', 'ARCHIVEDVID', 'b@x.com', 'yo', '2026-07-11'],
  ]);
  const videosSpreadsheet = {
    getSheets: () => [liveSheet],
    getSheetByName: (n) => (n === 'Archive' ? archiveSheet : null),
  };
  const commentsSpreadsheet = {
    getSheets: () => [commentsSheet],
    getSheetByName: (n) => (n === 'Votes' ? votesSheet : null),
    insertSheet: () => votesSheet,
  };
  const blank = { getSheets: () => [makeSheet([['key', 'value']])], getSheetByName: () => null };
  const byId = { VIDEOS_ID: videosSpreadsheet, COMMENTS_ID: commentsSpreadsheet };

  const globals = {
    SpreadsheetApp: { openById: (id) => byId[id] || blank },
    CacheService: makeCache(),
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Logger: { log() {} },
    Utilities: {}, UrlFetchApp: {}, ScriptApp: {},
  };
  const patched = SRC
    .replace(/VIDEOS:\s*'[^']+'/, "VIDEOS: 'VIDEOS_ID'")
    .replace(/COMMENTS:\s*'[^']+'/, "COMMENTS: 'COMMENTS_ID'");
  const names = ['updateCommentCount'];
  const factory = new Function(...Object.keys(globals), `${patched}\nreturn { ${names.join(', ')} };`);
  return factory(...Object.values(globals));
}
