# Fix plan: fix/fe-perf-misc

**Phase:** P2 · **Ships via:** git push (Pages) · **Files:** `js/views.js`, `js/feed.js`, `js/cards.js`, `js/app.js`, `js/single-play.js`, `js/votes.js`, `js/share.js`, `js/toast.js`

## Findings closed
- **FE10 — Search re-renders the entire result set from scratch on every index chunk.** `ensureSearchIndex(partial => renderMatches(partial, false))` (`views.js:874`) runs `filterVideos` over the whole index (tokenizing every title/channel per call), `innerHTML = ''`, and rebuilds up to 200 cards — ~15× for a 5000-item catalog per search session. Every rebuild also wipes `state.expandedComments` and reloads promoted iframes.
- **FE17 — `insertCardChronologically` is O(n·m).** `cards.js:114` calls `querySelectorAll('.media-card')` per inserted short and reparses `dataset.publishedAt` into a `Date` per comparison; same pattern in `revalidateFeed`'s reorder pass (`app.js:589`).
- **FE20 — single-play `JSON.parse`s every YouTube postMessage.** `single-play.js:82` parses the API's `infoDelivery` (several/sec per player) before the cheap state check.
- **FE19 — `toggleVote` has no in-flight guard.** `votes.js:55`; a double-click issues two toggle POSTs.
- **FE18 — `CSS.escape` inconsistency.** `share.js:74` is the only escaped `[data-video-id="…"]` selector; ~20 others are unescaped (currently safe, invites a future break).
- **FE16 — `toast.js` has no null guard / no cap on concurrent toasts.**

## Approach
1. Throttle search progress renders to ~1/animation-frame (or ~250ms); precompute normalized token arrays once per video at merge time; diff the rendered list by `video_id` instead of `innerHTML = ''` (preserves expanded comments/iframes).
2. Cache parsed `publishedAt` (e.g. a numeric field set at card build) so insert/reorder compares numbers, not fresh `Date` parses.
3. Cheap `typeof`/prefix check before `JSON.parse` in single-play `handleMessage`.
4. Add an in-flight guard (disable button / boolean) on `toggleVote`.
5. Route dynamic `[data-video-id]` selectors through `CSS.escape` consistently.
6. Null-guard `toast` container access and cap concurrent toasts.

## Verification
- `tests/perf`: search render count bounded; insert/reorder no longer scales with DOM size (assert via instrumentation or timing budget).
- Unit: double-`toggleVote` issues one POST.
- Manual: typing a search query stays smooth on a large catalog; expanded comment threads survive incremental results.
