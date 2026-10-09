# Fix plan: fix/fe-cold-load-empty-state

**Phase:** P1 · **Ships via:** git push (Pages) · **Files:** `js/app.js`, `index.html` (empty-state markup), `css/style.css`

## Finding closed
- **FE2 — A failed cold load leaves a permanently blank page with a spinning sentinel.** On the initial-load path `loadNextPage` sets `empty.style.display = 'none'` (~L107); `empty.style.display = ''` is only reached in the success branch (~L166). On a first-visit failure (offline, or an Apps Script cold-start 500) the `catch` sets `loadFailed`, the `finally` hides the skeleton, but `state.hasMore` is still its default `true`, so the sentinel shows a bare spinner that retries silently on 1s→30s backoff forever. No empty state, no error text, no retry button, and no `navigator.onLine` check anywhere in `js/`.

## Approach
1. In `loadNextPage`'s `catch`/`finally`, when `state.videos.length === 0 && loadFailed`, populate `#feed-empty` with a failure message + a retry button (wired to call `loadNextPage()` again) and hide `#load-more-container`.
2. Differentiate offline (`navigator.onLine === false`) messaging ("You're offline") from a server error, and add an `online` event listener that retries when connectivity returns.
3. Keep the existing silent mid-scroll retry for the non-empty case unchanged.

## Verification
- e2e: block the feed request on first load → assert `#feed-empty` + retry button visible and the sentinel hidden (not a bare spinner).
- e2e: retry button click after the backend recovers loads the feed.
- Manual: offline first-load shows the offline message; going back online recovers.
