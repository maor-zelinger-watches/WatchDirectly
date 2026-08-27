# Fix plan: fix/fe-state-refactor

**Phase:** P2 (prevent-recurrence) · **Ships via:** git push (Pages) · **Files:** `js/state.js`, `js/votes.js`, `js/comments-ui.js`, `js/app.js`

## Findings closed
- **FE13 — The "update every list holding this row" pattern is duplicated 4×.** `updateCachedVoteCount` (`votes.js:33`) and `updateCachedCommentCount` (`comments-ui.js:214`) are structurally identical (walk `state.videos`, `state.topVideos`, `state.searchIndex`, then persist); `revalidateFeed` inlines two more near-copies (`app.js:406`, `app.js:609`) that already diverge. The comment admits the failure mode: "Any list missing here would re-render with a stale count (that's exactly how search cards lost their counts)."
- **FE11 — `state.renderToken` is dead code.** 11 writes, zero reads (obsoleted when `appendCards` became a single synchronous pass). The comment at `app.js:483` describes a no-op guarantee, which is worse than no comment.
- **FE14 (partial) — Seven ad-hoc generation counters with no owner.** `renderToken`, `filterRenderToken`, `viewToken`(?), `prefetchToken`, `topUpToken`, `voteEpoch`, `starEpoch` each hand-rolled.
- **FE12 — Comment refresh writes into a possibly-detached element after an unguarded 300ms timer.** `comments-ui.js:56` captures `listEl` then renders inside `setTimeout(..., 300)` with no liveness check; if the user collapses/switches or the container rebuilds, the fresh comments render into an orphan node and are lost (self-corrects on re-expand). Also `JSON.stringify(cached.tree) !== JSON.stringify(tree)` serializes both trees on every expand.

## Approach
1. Add `patchVideoEverywhere(videoId, fields)` in `state.js` iterating a registry of row-holding lists (`videos`, `topVideos`, `searchIndex`, extensible); call it from all four sites. Persist once (coalesced — see `fix/fe-cache-render-fixes`).
2. Delete the `renderToken` field, all 11 increments, and the now-false comments.
3. Introduce one `Epoch` helper (`const e = epoch.claim('feed'); … if (!e.current()) return;`) and migrate the remaining counters incrementally.
4. In the comment-refresh timer, re-check `listEl.isConnected` before rendering; replace the double `JSON.stringify` with a cheap signature (`comment_id`+`created_at` join).

## Verification
- `npm test` green (the `revalidate_race` and vote/comment count tests still pass through `patchVideoEverywhere`).
- Unit: patching a count updates all three lists; a detached `listEl` is skipped.
- e2e: search cards show live counts after voting; collapsing a card mid-refresh loses nothing on re-expand.
