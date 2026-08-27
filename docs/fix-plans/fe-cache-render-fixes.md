# Fix plan: fix/fe-cache-render-fixes

**Phase:** P1 · **Ships via:** git push (Pages) · **Files:** `js/app.js`, `js/cache.js`, `js/votes.js`, `js/comments-ui.js`, `js/views.js`

## Findings closed
- **FE3 — Cached multi-page restore replays the staggered entrance animation.** `showCachedFeed` (`js/app.js:345`) calls `appendCards(cached.videos)`, whose own doc says the entrance animation is for network arrivals only and re-renders must use `renderList`. The cache holds every scrolled page, so an 8-page (80-item) cache gives `--enter-delay` up to `79*60ms ≈ 4.7s`; cards occupy layout immediately but stay `opacity:0` → a column of blank gaps filling in over ~5s.
- **FE5 — Every upvote/comment re-serializes the whole loaded feed.** `updateCachedVoteCount` (`votes.js:33`) and `updateCachedCommentCount` (`comments-ui.js:214`) call `saveFeedCache(state.videos, ...)` — `JSON.stringify` over the entire accumulated feed (~300 rows after 30 pages), synchronously, on every vote (twice, incl. reconcile).
- **FE6 — Search-index cache has no TTL/version and can never go stale.** `saveSearchIndex` writes up to 5000 rows; `loadSearchIndex` accepts any non-empty array. A flaky-network build failure runs the whole session on a months-old catalog with no indication.
- **FE7 — `appendArchiveToIndex` unbounded parallel fan-out ignoring the cap.** `views.js:144` computes the page list against the full `SEARCH_INDEX_LIMIT`, not remaining headroom, and the `>= cap` guard sits inside the `.then` after `Promise.all` already dispatched every request → downloads and discards pages.

## Approach
1. `showCachedFeed`: render via `renderList` (or clamp the stagger index, `Math.min(i, 8) * 60`) so restore paints instantly.
2. Coalesce `saveFeedCache` writes behind a trailing `requestIdleCallback`/debounce; cap the persisted snapshot to the first N pages rather than the unbounded list. (Pairs with the `patchVideoEverywhere` registry in `fix/fe-state-refactor`.)
3. `cache.js`: add `{version, savedAt}` to the feed and search-index payloads; reject on version mismatch or age > 24h (self-heal to absent).
4. `appendArchiveToIndex`: `remaining = cap - state.searchIndex.length`; build the page list from `remaining` and bound concurrency (same fix for the live-catalog fan-out ~L99–109).

## Verification
- Unit: cache version/TTL rejects stale/old payloads; save caps snapshot length.
- e2e: scroll several pages, refresh → instant paint, no blank-gap fade.
- Manual: rapid voting doesn't stall tap response; Network shows no discarded archive pages past the cap.
