# Fix plan: fix/test-url-and-hygiene

**Phase:** P1 · **Ships via:** git push (repo/tests only) · **Files:** `tests/smoke/*.spec.js`, `tests/unit/auth.test.js` (new), `tests/perf/helpers.js`, delete `tests/backend/`, delete `tests/e2e/debug.spec.js`

## Findings closed
- **T2 — Smoke suite targets the retired GitHub Pages URL.** `PROD_URL = 'https://maor-zelinger-watches.github.io/WatchDirectly/'` in `production.spec.js:13` (and `feed_health.spec.js:14`) while `CNAME` is now `www.howyouwatch.com`. Every smoke assertion now validates a 301 redirect chain, so it can't detect an expired cert, missing OAuth origin, or broken `/`-absolute 404 — the suite stays green while the real site is down.
- **T16 — Four `toHaveCount(0)` smoke tests assert the absence of removed features.** `production.spec.js` ~L31–42/145–153 match selectors that no longer exist regardless of health → pass forever.
- **T5 — `js/auth.js` (381 LOC) has no unit test; e2e seeds a fake session and bypasses it.** Token decode, expiry, session restore, sign-out cleanup, avatar render are exercised by nothing.
- **T9 — `tests/backend/parser.spec.js` is run by no runner and is tautological.** Matches neither `vitest.config.js` (`tests/unit/**`,`tests/integration/**`) nor `playwright.config.js` globs; its one assertion is `expect(codeGs).toBeDefined()`. Superseded by `tests/unit/backend/parser.test.js`.
- **T10 — `tests/e2e/debug.spec.js` is a scratch file.** Only asserts the skeleton hides, then `console.log`s the feed HTML — twice per run (mobile+desktop), burying real failures.
- **T11 — `tests/perf/helpers.js` hardcodes five tuning knobs.** Mirrors `PAGE_SIZE`/`PREFETCH_PAGES_AHEAD`/etc. from `js/config.js`; tuning a knob leaves perf asserting old values.

## Approach
1. Repoint both smoke `PROD_URL`s to `https://www.howyouwatch.com/`; add a `/nonexistent` case asserting the styled 404 renders with a working `/` link; delete the four absence-asserting tests.
2. Add `tests/unit/auth.test.js`: JWT/session payload parsing (incl. malformed/expired), persist/restore round-trip against a jsdom `localStorage`, sign-out clears state. (Supports `fix/fe-auth-robustness`.)
3. Delete `tests/backend/` and `tests/e2e/debug.spec.js`.
4. `tests/perf/helpers.js`: `import { CONFIG } from '../../js/config.js'` and derive the five constants.

## Verification
- `npm test` green with the new auth suite; `npm run test:smoke` runs against the live domain (locally or via the scheduled CI job).
- `git grep github.io tests/` returns nothing.
