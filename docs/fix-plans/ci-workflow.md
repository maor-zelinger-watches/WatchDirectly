# Fix plan: fix/ci-workflow

**Phase:** P1 · **Ships via:** git push (repo only; no runtime effect) · **Files:** `.github/workflows/ci.yml` (new)

## Finding closed
- **T1 — No CI workflow exists at all.** `playwright.config.js` is fully CI-aware (`forbidOnly`, `retries: 2`, `workers: 1`, the `github` reporter) but nothing ever sets `CI` — there is no `.github` directory. 381 vitest cases + ~150 Playwright cases run only when someone remembers `npm run test:all` locally, and `forbidOnly` (the guard against a committed `test.only`) is dead code that can never fire.

## Approach
1. Add `.github/workflows/ci.yml`:
   - On `push` and `pull_request`: `npm ci`, `npx playwright install --with-deps chromium`, `npm test` (vitest), `npm run test:e2e` (mobile + desktop chrome). Sets `CI=true` (GitHub provides it), activating `forbidOnly` and retries.
   - On a `schedule` (e.g. daily) and `workflow_dispatch`: `npm run test:smoke` and `npm run test:perf` — kept **off** per-push so the live Apps Script backend isn't hammered on every commit.
2. Cache `~/.npm` and the Playwright browser download for speed.
3. Upload the `playwright-report/` artifact on failure.

## Verification
- Open a throwaway PR (or `act`/`workflow_dispatch`) → the unit + e2e jobs run and pass; a deliberate `test.only` fails the run (proves `forbidOnly`).
- Confirm the scheduled job targets the production URL fixed in `fix/test-url-and-hygiene`.

## Note
No app behavior changes; this is infra. Independent of every other branch.
