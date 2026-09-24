# Fix plan: feature/storage-engine-flag

**Phase:** pre-rollout gate for `feature/idb-cache-storage` · **Ships via:** deploy skill (frontend bump; tests ride along) · **Files:** `js/flags.js` (new), `js/cache.js`, `js/config.js`, `js/app.js`, tests

**Worktree:** `.claude/worktrees/storage-engine-flag`, branched from `feature/idb-cache-storage` at `1765323`. Never work on `main`.

## Goal

Ship the IndexedDB storage engine **switched off**, behind a per-browser flag in `localStorage`, so the deploy is a no-op for every user until the flag is flipped — and any browser can be flipped back. Both systems stay in the build; the flag picks one **per page load**.

Non-goals: removing localStorage, changing `cache.js`'s public API, touching the backend, re-running the benchmark (the tooling only gains a mode switch).

## Background you need

- `js/cache.js` already routes the four large snapshots (`wd_feed_cache`, `wd_search_index`, `wd_top_cache`, `wd_channels`) through `js/storage.js` engines picked by `ENGINE_PREFERENCE` (L119–125: every key → `['idb', 'cache', 'local']`). Stars/bookmarks/filter-types stay synchronous localStorage and are out of scope.
- The `local` engine **is** the old system: same keys, same `{version, savedAt}` envelope, same self-heal. Callers (`app.js`, `views.js`) already `await` the snapshot API, so a preference of `['local']` reproduces today's production behavior on the new code path.
- `loadSnapshot` (L174) migrates a localStorage copy into the engine when the engine is not `local` (`takeLegacy`, L152; guard at L179). `saveSnapshot` (L207) removes the localStorage copy when the engine is not `local`.
- `js/share.js` `clearShareParam()` (L30) does `history.replaceState(null, '', location.pathname)` — it strips the **whole** query string on fullscreen exit / deep-link handling. Anything read from a URL param must be persisted before that can run.
- Benchmark evidence (2026-09-24, WebKit): on `main` the search index failed to persist (0 of 3702 rows), and a returning visitor's search re-walked the catalog — 36,297 ms, 43 requests; the engine branch persisted 4201/4201 and did it in 169 ms / 1 request. Chromium showed no functional difference (index fits its localStorage). Warm-paint latency was inconclusive (n=2, one 1766 ms outlier). See `tests/perf-live/`.

## Design (decided — do not relitigate)

1. **Flag key:** `wd_storage_engine` in `localStorage`. Values: `'idb'` | `'legacy'`. Absent, unreadable, or anything else → `CONFIG.STORAGE_ENGINE_DEFAULT`.
2. **Default:** `CONFIG.STORAGE_ENGINE_DEFAULT = 'legacy'` (new constant in `js/config.js`, with a comment that rollout = flip this one value; users with an explicit flag keep theirs).
3. **Read once per page load, memoized.** The engine must never change between a write and its read in one session. A flip takes effect on the next load — say so in the module doc.
4. **Never throws.** Reading the flag wraps `localStorage` in try/catch; blocked storage → default.
5. **Mechanism:** the flag selects the preference list. `legacy` → `['local']` for every key. `idb` → `['idb', 'cache', 'local']` (unchanged). One code path; the difference is which engines `pickEngine` is allowed to probe.
6. **Kill-switch property:** in `legacy` mode IndexedDB and Cache Storage are **never probed, opened, or created**. This is what makes it a safe fallback for a browser where IndexedDB misbehaves. Test it (see Verification).
7. **Migration semantics:**
   - `legacy → idb`: existing `takeLegacy` path adopts the localStorage copy, writes it through, frees localStorage. No new code.
   - `idb → legacy`: localStorage is empty (it was moved out), so the next load is a one-time cold rebuild from the network. **Do not reverse-migrate** — legacy mode must not touch IndexedDB. The orphaned IndexedDB copy is bounded and harmless; leave it.
8. **URL convenience:** `?storage=idb` / `?storage=legacy` writes the flag; `?storage=default` removes it. Processed at `js/flags.js` module-init time (top-level, before any cache read — `cache.js` imports `flags.js`, and boot in `app.js` runs after module evaluation). Needed because iOS Safari — where this matters most — has no devtools. Do **not** strip the param yourself; `share.js` may, and the flag is already persisted by then. Guard `typeof location !== 'undefined'` so the module loads under jsdom.
9. **Observability:** one line at boot next to the version log in `app.js` (L90): `storage engine: idb (flag)` / `legacy (default)` / `legacy (flag)`. `flags.js` exports `storageEngine()` returning `{ engine, source: 'flag' | 'default' }` for that line and for tests.

## Approach (implementation order)

1. **`js/flags.js`** (new): `FLAG_KEYS`, `storageEngine()` (memoized), `setStorageEngineFlag(value | null)`, the `?storage=` handler at module init, `__test__.reset()` to clear the memo. Module doc explains per-load semantics and the URL param.
2. **`js/config.js`:** add `STORAGE_ENGINE_DEFAULT: 'legacy'` with the rollout comment.
3. **`js/cache.js`:** replace the static `ENGINE_PREFERENCE` export with `enginePreference(key)` computed from `storageEngine().engine`; keep exporting the two lists as constants (`IDB_PREFERENCE`, `LEGACY_PREFERENCE`) for tests. Update `loadSnapshot` / `saveSnapshot` / `removeSnapshot` to call it. Update the module doc's "two tiers" paragraph to describe the flag.
4. **`js/app.js`:** the boot log line (step 9 above). Nothing else — `showCachedFeed` already awaits.
5. **Tests** (below). Existing suites must stay green **without edits to their expectations**: with the default `legacy`, e2e/perf run exactly today's production behavior, which makes the current 279 e2e + 16 perf the regression guard for "flag off = unchanged".
6. **perf-live:** `PERF_LIVE_STORAGE=idb|legacy` env var. `tests/perf-live/helpers.js` gains `applyStorageFlag(page)` (an `addInitScript` that sets or removes `wd_storage_engine`); both specs call it first. `compare.perf-live.spec.js` defaults `PERF_LIVE_LABEL` to the mode so one checkout can be compared against itself — no baseline worktree needed. Document in `playwright.perf-live.config.js`'s header.
7. **Docs:** a short "Storage engine flag" section in `README.md` (how to flip, what the console line means, that flips apply on next load, that idb→legacy costs one cold rebuild).

## Verification

Unit (`npm test`):
- `tests/unit/flags.test.js` (new): default when absent; `'idb'`/`'legacy'` honored; junk value → default; `localStorage.getItem` throwing → default; memoized (a second read after the key changes returns the first value until `__test__.reset()`); `?storage=idb` writes, `?storage=default` removes, other values ignored; `setStorageEngineFlag(null)` removes.
- `tests/unit/storage_engines.test.js`: wrap in `describe.each(['idb', 'legacy'])` setting the flag in `beforeEach` (and calling `flags.__test__.reset()` alongside `storageTest.reset()`). In `legacy`: all four snapshots land in localStorage; **`indexedDB.open` and `caches.open` are never called** (spy on the fakes); an existing IndexedDB copy is ignored; `takeLegacy` never runs. In `idb`: every current assertion unchanged. Migration `describe` runs in `idb` only.
- `tests/unit/cache.test.js`, `cache_versioning.test.js`: set the flag to `legacy` explicitly in `beforeEach` (they currently pass only because jsdom lacks IndexedDB — make the intent explicit).

E2E (`npm run test:e2e -- --workers=2` — the 8 GB Air needs the cap):
- `tests/e2e/storage_flag.spec.js` (new, mocked backend like `dedup_cache.spec.js`):
  1. flag absent → after load, `wd_feed_cache` is in localStorage and `indexedDB.databases()` has no `wd-store`;
  2. flag `idb` via `addInitScript` → reload with the feed route blocked still paints cards; localStorage lacks the key; `wd-store` holds it;
  3. first visit with `?storage=idb`, second visit without the param → still IndexedDB (the param persisted);
  4. `?storage=default` clears the key;
  5. flip `idb → legacy` between loads → the feed paints from the network (cold), no error toast, IndexedDB content unchanged.
- Whole existing suite green at the default.

Perf: `npm run test:perf` (mocked, 16 tests) green at the default. Then, by hand, not in any gate:
`PERF_LIVE_STORAGE=legacy npm run test:perf-live -- --project=webkit` and `…=idb …` — the storage spec's warm-paint checks must pass in both; compare with `node tests/perf-live/summarize.mjs`.

## Rollout (after this lands)

1. Deploy with the default `legacy` — zero behavior change for users.
2. Flip your own browsers with `?storage=idb`; live with it; run perf-live in both modes on a couple of days when the backend is fast (today it was ~10 s/request, which drowned the cold numbers).
3. Follow-up branch: `STORAGE_ENGINE_DEFAULT = 'idb'`. Anyone who set `legacy` explicitly stays on it.
4. Later: remove the flag and the `local` preference.

## Gotchas

- `flags.js` must not import `config.js` lazily inside a function that runs at module init before `config.js` evaluates — plain top-level `import { CONFIG }` is fine (ESM hoists).
- Keep `flags.js` dependency-free otherwise; `cache.js` → `flags.js` → `config.js` must not cycle.
- Deep links: `?v=<id>&storage=idb` must keep working — `share.js` reads `v` with `URLSearchParams` (L71); don't touch it.
- Don't add the flag to `cache.js`'s `CACHE_KEYS` — it is not a cache and must never be cleared by cache clears.
- CSP is `script-src 'self'`; nothing external.
- Firefox can't launch under this machine's sandbox (`plugin-container` denied) — verify Firefox manually or in CI, not locally.
- Attribution on commits: `Co-Authored-By: Claude <model> <noreply@anthropic.com>` per the session reminder.
