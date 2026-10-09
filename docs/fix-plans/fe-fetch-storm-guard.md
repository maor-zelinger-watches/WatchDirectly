# Fix plan: fix/fe-fetch-storm-guard

**Phase:** P0 (critical) · **Ships via:** git push (Pages) · **Files:** `js/app.js`, `js/views.js`, `js/state.js`

## Finding closed
- **FE1 — Content-type filter can trigger an unbounded page-fetch storm.** `isFilterActive()` (`js/state.js:64`) deliberately excludes `filter.types`, so the sentinel-retrigger loop in `loadNextPage`'s `finally` (`js/app.js` ~L237–261) keeps firing while a chip filter is active. Chips hide cards via `display:none`, so a fetched page whose items are all hidden adds **zero** height; `rect.top <= window.innerHeight + 600` stays true and the `requestAnimationFrame` nudge recurses immediately. `topUpTypeFilter`'s `TYPE_FILTER_TOP_UP_MAX_PAGES` cap bounds only its own loop — the rAF retrigger has none. Selecting a sparse type (e.g. only "Shorts") walks the whole catalog 10 items/page, each iteration also firing `refillPrefetchBuffer` (+3 pages) and a full `saveFeedCache` re-serialize — a multi-minute stall against per-user-serialized Apps Script.

## Approach
1. Track consecutive pages that add no *visible* card height (or no increase in visible-count) in `loadNextPage`; after N (mirror the `TYPE_FILTER_TOP_UP_MAX_PAGES` constant style in `js/config.js`) stop the rAF nudge and hide the sentinel until the filter changes or the user scrolls with intent.
2. Apply the same guard to the sibling retrigger block in `js/views.js` (~L584–605), which is a verbatim copy (dedupe candidate — see `fix/fe-state-refactor`).
3. Keep the existing behavior when no type filter is active (unfiltered Latest must still auto-fill).

## Verification
- `tests/perf`: select a sparse content type, assert bounded page fetches (not full-catalog).
- e2e: filter to a rare type, confirm no runaway network and the sentinel settles.
- Manual: throttle network, select "Shorts", watch Network tab stop after the cap.
