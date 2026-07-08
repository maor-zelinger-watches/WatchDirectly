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

/** A fresh in-memory CacheService. TTL is ignored — tests don't advance time. */
function memoryCache() {
  const store = new Map();
  const cache = {
    get: (k) => (store.has(k) ? store.get(k) : null),
    put: (k, v) => { store.set(k, v); },
    remove: (k) => { store.delete(k); },
  };
  return { getScriptCache: () => cache, _store: store };
}

/**
 * Records ScriptApp trigger installs/removals so the async-refresh tests can
 * assert exactly what handleFeed scheduled. `initial` seeds pending handlers.
 */
function triggerRecorder(initial = []) {
  let triggers = initial.map((fn) => ({ getHandlerFunction: () => fn }));
  const created = [];
  const scriptApp = {
    getProjectTriggers: () => triggers.slice(),
    newTrigger: (fn) => ({
      timeBased: () => ({ after: () => ({ create: () => {
        created.push(fn);
        triggers.push({ getHandlerFunction: () => fn });
      } }) }),
    }),
    deleteTrigger: (t) => { triggers = triggers.filter((x) => x !== t); },
  };
  return { scriptApp, created, remaining: () => triggers.map((t) => t.getHandlerFunction()) };
}

/** Eval Code.gs with injected mock globals; return the named functions. */
function loadBackend(mocks = {}) {
  const sheet = mocks.sheet || blankSheet();
  const globals = {
    UrlFetchApp: mocks.UrlFetchApp || { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{}' }) },
    SpreadsheetApp: mocks.SpreadsheetApp || spreadsheetReturning(sheet),
    LockService: mocks.LockService || { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: mocks.CacheService || memoryCache(),
    Utilities: mocks.Utilities || {
      getUuid: () => '00000000-0000-0000-0000-000000000000',
      computeDigest: () => [], base64EncodeWebSafe: () => 'x', sleep() {},
      DigestAlgorithm: { MD5: 'MD5', SHA_256: 'SHA_256' },
    },
    Logger: { log() {} },
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
    ScriptApp: mocks.ScriptApp || {}, XmlService: {},
  };
  const names = [
    'verifyGoogleToken', 'toIsoDate', 'handleAddComment', 'decodeHtmlEntities',
    'handleFeed', 'handleBootstrap', 'kickoffRefresh',
    'getVideos', 'updateVoteCount', 'updateCommentCount', 'handleTopWeek',
  ];
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

describe('handleFeed (perf — a read must never crawl inline)', () => {
  it('serves the feed immediately and schedules an async refresh when stale', () => {
    const rec = triggerRecorder();
    let crawlFetches = 0;
    const be = loadBackend({
      ScriptApp: rec.scriptApp,
      // Any fetch here would mean the crawl ran inline — count them.
      UrlFetchApp: { fetch: () => { crawlFetches++; return { getResponseCode: () => 200, getContentText: () => '<rss></rss>' }; } },
    });
    // Blank META → no last_fetch → stale.
    const res = be.handleFeed({ page: '1', limit: '10' });
    expect(res.status).toBe('ok');
    expect(res.stale).toBe(true);
    expect(crawlFetches).toBe(0);                     // did NOT crawl inline
    expect(rec.created).toEqual(['kickoffRefresh']);  // scheduled it instead
  });

  it('does not stack a second trigger when a refresh is already pending', () => {
    const rec = triggerRecorder(['kickoffRefresh']);
    const be = loadBackend({ ScriptApp: rec.scriptApp });
    be.handleFeed({ page: '1', limit: '10' });
    expect(rec.created).toEqual([]);                  // one pending refresh is enough
  });

  it('kickoffRefresh removes its own one-shot trigger before crawling', () => {
    const rec = triggerRecorder(['kickoffRefresh', 'scheduledFetchAllFeeds']);
    // A recent fetch_in_progress marker makes fetchAllFeeds no-op, so the test
    // exercises trigger cleanup without running the real crawl.
    const metaSheet = blankSheet({
      getDataRange: () => ({ getValues: () => [['key', 'value'], ['fetch_in_progress', new Date().toISOString()]] }),
    });
    const be = loadBackend({ ScriptApp: rec.scriptApp, sheet: metaSheet });
    be.kickoffRefresh();
    expect(rec.remaining()).toEqual(['scheduledFetchAllFeeds']); // only kickoffRefresh removed
  });
});

describe('handleBootstrap (batched votes + stars, one token check)', () => {
  // getVotesSheet and getStarsSheet resolve to the SAME mock sheet, so give it
  // both column sets: video_id/user_email for votes, channel_name/user_email
  // for stars.
  const combinedSheet = () => blankSheet({
    getDataRange: () => ({ getValues: () => [
      ['video_id', 'channel_name', 'user_email'],
      ['vidA', 'ChanX', 'user@example.com'],
      ['vidB', 'ChanX', 'user@example.com'],
      ['vidC', 'ChanY', 'other@example.com'],
    ] }),
  });

  it("returns the user's votes and stars, verifying the token once", () => {
    let tokenFetches = 0;
    const be = loadBackend({
      sheet: combinedSheet(),
      UrlFetchApp: { fetch: () => { tokenFetches++; return { getResponseCode: () => 200, getContentText: () => JSON.stringify(validClaims()) }; } },
    });
    const res = be.handleBootstrap({ token: 't' });
    expect(res.status).toBe('ok');
    expect(res.video_ids).toEqual(['vidA', 'vidB']);
    expect(res.channels).toEqual(['ChanX']);          // deduped
    expect(tokenFetches).toBe(1);                     // ONE tokeninfo call for the batch
  });

  it('rejects a missing token', () => {
    const be = loadBackend({ sheet: combinedSheet() });
    expect(be.handleBootstrap({}).status).toBe('error');
  });

  it('rejects an invalid token (aud mismatch)', () => {
    const be = loadBackend({ sheet: combinedSheet(), UrlFetchApp: tokeninfo({ ...validClaims(), aud: 'attacker' }) });
    expect(be.handleBootstrap({ token: 't' }).status).toBe('error');
  });
});

describe('verifyGoogleToken (caching — skip the tokeninfo round trip)', () => {
  // Distinct cache keys per token so different tokens can't collide.
  const hashingUtilities = {
    getUuid: () => 'x', sleep() {},
    computeDigest: (_algo, str) => Array.from(String(str)).map((c) => c.charCodeAt(0)),
    base64EncodeWebSafe: (bytes) => bytes.join(','),
    DigestAlgorithm: { SHA_256: 'SHA_256' },
  };

  it('serves a repeat verification of the same token from cache (no second fetch)', () => {
    let fetches = 0;
    const be = loadBackend({
      Utilities: hashingUtilities,
      UrlFetchApp: { fetch: () => { fetches++; return { getResponseCode: () => 200, getContentText: () => JSON.stringify(validClaims()) }; } },
    });
    const a = be.verifyGoogleToken('tok-123');
    const b = be.verifyGoogleToken('tok-123');
    expect(a).toEqual({ email: 'user@example.com', name: 'User', picture: 'https://x/p.jpg' });
    expect(b).toEqual(a);
    expect(fetches).toBe(1);                          // second call hit the cache
  });

  it('ignores a cached entry whose exp has passed and re-verifies live', () => {
    let fetches = 0;
    const store = new Map();
    const cache = { get: (k) => (store.has(k) ? store.get(k) : null), put: (k, v) => store.set(k, v) };
    const key = 'tok_' + Array.from('tok-xyz').map((c) => c.charCodeAt(0)).join(',');
    store.set(key, JSON.stringify({ email: 'stale@example.com', name: 'Stale', picture: '', exp: nowSec() - 100 }));
    const be = loadBackend({
      Utilities: hashingUtilities,
      CacheService: { getScriptCache: () => cache },
      UrlFetchApp: { fetch: () => { fetches++; return { getResponseCode: () => 200, getContentText: () => JSON.stringify(validClaims()) }; } },
    });
    const res = be.verifyGoogleToken('tok-xyz');
    expect(fetches).toBe(1);                          // stale cache not trusted → live verify
    expect(res.email).toBe('user@example.com');       // fresh identity, not the stale cached one
  });

  it('does not cache a failed verification', () => {
    let fetches = 0;
    const be = loadBackend({
      Utilities: hashingUtilities,
      UrlFetchApp: { fetch: () => { fetches++; return { getResponseCode: () => 401, getContentText: () => '{}' }; } },
    });
    expect(be.verifyGoogleToken('bad')).toBeNull();
    expect(be.verifyGoogleToken('bad')).toBeNull();
    expect(fetches).toBe(2);                          // failures re-verify every time
  });
});

describe('getVideos feed-head cache (skip the sheet scan on early pages)', () => {
  // The shared mock sheet backs EVERY spreadsheet (videos, votes, comments),
  // so the header row carries the columns each code path looks up.
  const HEADERS = ['video_id', 'user_email', 'url', 'published_at', 'vote_count', 'comment_count', 'channel_name'];
  const ROWS = [
    ['vid1', '', 'https://a', '2026-01-02T00:00:00.000Z', 1, 0, 'Chan'],
    ['vid2', '', 'https://b', '2026-01-01T00:00:00.000Z', 0, 0, 'Chan'],
  ];

  /** A videos sheet that counts full reads, the cost the cache exists to skip. */
  function countingSetup(rows = ROWS) {
    let reads = 0;
    const sheet = blankSheet({
      getDataRange: () => ({ getValues: () => { reads++; return [HEADERS, ...rows]; } }),
    });
    const cacheService = memoryCache();
    const be = loadBackend({ sheet, CacheService: cacheService });
    return { be, cacheService, reads: () => reads };
  }

  it('serves a repeat page-1 request from cache without re-reading the sheet', () => {
    const { be, reads } = countingSetup();
    const first = be.getVideos(1, 10, '');
    expect(first.videos.map((v) => v.video_id)).toEqual(['vid1', 'vid2']); // newest first
    expect(reads()).toBe(1);

    const second = be.getVideos(1, 10, '');
    expect(reads()).toBe(1);                          // cache hit — no second scan
    expect(second.videos.map((v) => v.video_id)).toEqual(['vid1', 'vid2']);
    expect(second.total).toBe(first.total);
    expect(second.next_cursor).toBe(first.next_cursor);
  });

  it('cursor requests always take the live path', () => {
    const { be, reads } = countingSetup();
    be.getVideos(1, 10, '');                          // populates the head
    const res = be.getVideos(2, 1, '2026-01-02T00:00:00.000Z|vid1');
    expect(reads()).toBe(2);                          // cursor resolution needs the full catalog
    expect(res.videos.map((v) => v.video_id)).toEqual(['vid2']);
  });

  it('a vote recount invalidates the head so the next read serves fresh counts', () => {
    const { be, reads } = countingSetup();
    be.getVideos(1, 10, '');                          // 1 read — populates cache
    be.updateVoteCount('vid1');                       // +2 reads (votes tab + videos sheet)
    be.getVideos(1, 10, '');                          // must re-scan: counts changed
    expect(reads()).toBe(4);                          // 3 would mean a stale cached count was served
  });

  it('a comment recount invalidates the head too', () => {
    const { be, reads } = countingSetup();
    be.getVideos(1, 10, '');                          // 1 read
    be.updateCommentCount('vid1');                    // +2 reads (comments + videos)
    be.getVideos(1, 10, '');                          // must re-scan
    expect(reads()).toBe(4);
  });

  it('a cached head holding an expired premiere is a miss, not re-filtered', () => {
    const { be, cacheService, reads } = countingSetup();
    // Seed a head whose entry expired between populate and read. Serving it
    // would resurface a premiere that never aired; re-filtering it in place
    // would shift offsets/total. Either way: fall through to the live path.
    cacheService._store.set('feed_head_v1', JSON.stringify({
      videos: [{ video_id: 'ghost', url: 'https://g', published_at: '2026-01-03T00:00:00.000Z', expires_at: new Date(Date.now() - 1000).toISOString() }],
      total: 1,
    }));
    const res = be.getVideos(1, 10, '');
    expect(reads()).toBe(1);                          // went to the sheet
    expect(res.videos.map((v) => v.video_id)).toEqual(['vid1', 'vid2']); // no ghost
  });
});

describe('handleTopWeek (rolling 7-day window, vote-ranked, cached)', () => {
  const HEADERS = ['video_id', 'url', 'published_at', 'vote_count', 'comment_count', 'channel_name'];
  // Dates are relative to now so the rolling window is exercised, not a fixed
  // date that would drift out of range as real time passes.
  const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

  /** A videos sheet that counts full reads — the scan the cache exists to skip. */
  function setup(rows) {
    let reads = 0;
    const sheet = blankSheet({
      getDataRange: () => ({ getValues: () => { reads++; return [HEADERS, ...rows]; } }),
    });
    const cacheService = memoryCache();
    const be = loadBackend({ sheet, CacheService: cacheService });
    return { be, cacheService, reads: () => reads };
  }

  it('pulls items from across the entire 7-day window and excludes older ones', () => {
    // One video per day for the last 7 days (0..6 days old), each with more votes
    // than the day before, plus a high-voted item 8 days old that must NOT leak in.
    const rows = [];
    for (let d = 0; d <= 6; d++) rows.push(['d' + d, 'https://x/' + d, daysAgo(d), d, 0, 'Chan']);
    rows.push(['old', 'https://x/old', daysAgo(8), 99, 0, 'Chan']); // outside the window
    const { be } = setup(rows);

    const res = be.handleTopWeek({ limit: 50 });
    const ids = res.videos.map((v) => v.video_id);
    expect(res.total).toBe(7);                          // all 7 in-window days
    expect(ids).not.toContain('old');                   // 99 votes can't override the window
    expect(ids).toContain('d6');                        // the ~6-day-old edge item is still pulled
    expect(ids).toEqual(['d6', 'd5', 'd4', 'd3', 'd2', 'd1', 'd0']); // votes desc
  });

  it('serves a repeat request from cache without re-scanning the sheet', () => {
    const rows = [['a', 'https://a', daysAgo(1), 5, 0, 'Chan'], ['b', 'https://b', daysAgo(2), 3, 0, 'Chan']];
    const { be, reads } = setup(rows);

    const first = be.handleTopWeek({ limit: 50 });
    expect(reads()).toBe(1);
    const second = be.handleTopWeek({ limit: 50 });
    expect(reads()).toBe(1);                            // cache hit — no second scan
    expect(second.videos.map((v) => v.video_id)).toEqual(first.videos.map((v) => v.video_id));
    expect(second.total).toBe(first.total);
  });

  it('a vote recount invalidates the cached window so the next read re-scans', () => {
    const rows = [['a', 'https://a', daysAgo(1), 5, 0, 'Chan'], ['b', 'https://b', daysAgo(2), 3, 0, 'Chan']];
    const { be, reads } = setup(rows);

    be.handleTopWeek({ limit: 50 });                    // 1 read — populates cache
    be.updateVoteCount('a');                            // +2 reads (votes tab + videos sheet)
    be.handleTopWeek({ limit: 50 });                    // must re-scan: ranking changed
    expect(reads()).toBe(4);                            // 3 would mean a stale cached ranking was served
  });

  it('a comment recount invalidates the cached window too', () => {
    const rows = [['a', 'https://a', daysAgo(1), 5, 0, 'Chan'], ['b', 'https://b', daysAgo(2), 3, 0, 'Chan']];
    const { be, reads } = setup(rows);

    be.handleTopWeek({ limit: 50 });                    // 1 read
    be.updateCommentCount('a');                         // +2 reads (comments + videos)
    be.handleTopWeek({ limit: 50 });                    // must re-scan
    expect(reads()).toBe(4);
  });

  it('a cached window holding an expired premiere is a miss, not served stale', () => {
    const rows = [['a', 'https://a', daysAgo(1), 5, 0, 'Chan']];
    const { be, cacheService, reads } = setup(rows);
    // Seed a window whose entry expired between populate and read. Serving it
    // would resurface a premiere that never aired; fall through to a live scan.
    cacheService._store.set('top_week_v1', JSON.stringify({
      videos: [{ video_id: 'ghost', url: 'https://g', published_at: daysAgo(1), expires_at: new Date(Date.now() - 1000).toISOString() }],
      total: 1,
    }));
    const res = be.handleTopWeek({ limit: 50 });
    expect(reads()).toBe(1);                            // went to the sheet
    expect(res.videos.map((v) => v.video_id)).toEqual(['a']); // no ghost
  });

  it('falls through to a live scan when the request exceeds the cached slice', () => {
    // Populate a cache of TOP_WEEK_CACHE_COUNT rows against a larger window, then
    // ask for more than the cap: the cache can't satisfy it, so re-scan.
    const rows = [];
    for (let i = 0; i < 60; i++) rows.push(['v' + i, 'https://x/' + i, daysAgo(1), 60 - i, 0, 'Chan']);
    const { be, reads } = setup(rows);

    const first = be.handleTopWeek({ limit: 50 });      // caches 50, total 60
    expect(reads()).toBe(1);
    expect(first.total).toBe(60);

    const big = be.handleTopWeek({ limit: 60 });        // 60 > cached 50 → live scan
    expect(reads()).toBe(2);
    expect(big.videos.length).toBe(60);

    const small = be.handleTopWeek({ limit: 50 });      // satisfiable from cache again
    expect(reads()).toBe(2);                            // no extra scan
    expect(small.videos.length).toBe(50);
  });

  it('pages through the entire week by cursor with no gaps or duplicates', () => {
    // 25 items, each a distinct vote count so the rank order is total and
    // deterministic; a page size of 10 forces three cursor-linked pages.
    const rows = [];
    for (let i = 0; i < 25; i++) rows.push(['v' + i, 'https://x/' + i, daysAgo(1), 100 - i, 0, 'Chan']);
    const { be } = setup(rows);

    const seen = [];
    let cursor = '';
    for (let guard = 0; guard < 10; guard++) {
      const res = be.handleTopWeek({ limit: 10, cursor });
      expect(res.total).toBe(25);
      seen.push(...res.videos.map((v) => v.video_id));
      cursor = res.next_cursor;
      if (!cursor) break;
    }
    // The full ranked order, once each: v0 (100 votes) .. v24 (76 votes).
    expect(seen).toEqual(rows.map((r) => r[0]));
    expect(new Set(seen).size).toBe(25);
  });

  it('reaches the oldest end of the week when votes are sparse (the reported bug)', () => {
    // 30 unvoted items spanning the week, ~5h apart, newest first. With no
    // votes the ranking is pure recency, so page 1 is only the newest slice —
    // the ~6-day-old items are reachable ONLY by paging, which is exactly what
    // a single capped response could never surface.
    const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push(['n' + i, 'https://x/' + i, hoursAgo(i * 5), 0, 0, 'Chan']);
    const { be } = setup(rows);

    const page1 = be.handleTopWeek({ limit: 10 });
    expect(page1.videos.map((v) => v.video_id))
      .toEqual(['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9']);

    let res = page1;
    const ids = [...page1.videos.map((v) => v.video_id)];
    while (res.next_cursor) {
      res = be.handleTopWeek({ limit: 10, cursor: res.next_cursor });
      ids.push(...res.videos.map((v) => v.video_id));
    }
    // The oldest item (n29, ~6 days old) is only reachable by paginating.
    expect(ids.length).toBe(30);
    expect(new Set(ids).size).toBe(30);
    expect(ids[ids.length - 1]).toBe('n29');
  });

  it('a malformed cursor is ignored — serves the first page rather than erroring', () => {
    const rows = [['a', 'https://a', daysAgo(1), 5, 0, 'Chan'], ['b', 'https://b', daysAgo(2), 3, 0, 'Chan']];
    const { be } = setup(rows);
    const res = be.handleTopWeek({ limit: 10, cursor: 'not-a-real-cursor' });
    expect(res.status).toBe('ok');
    expect(res.videos.map((v) => v.video_id)).toEqual(['a', 'b']);
  });
});
