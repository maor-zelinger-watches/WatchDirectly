# Fix plan: fix/be-cache-generation-helper

**Phase:** P1 · **Ships via:** deploy skill (clasp) · **Files:** `apps-script/Code.gs`

Prevent-recurrence refactor: the three cache read/populate/invalidate triads are copy-pasted with divergent guards — which is exactly where the stale-data race hides.

## Findings closed
- **BE2 — Read-through cache repopulation races invalidation.** `getVideos` (~L2340), `handleTopWeek` (~L2567), and `readSortedArchive` (~L2151) each do `read sheet → sort → CacheService.put(...)` with no generation check. Request A reads at T0; a vote at T1 writes and calls `invalidateFeedHead()`; A's `put` lands at T2 and re-installs the pre-vote snapshot for the full TTL (300s feed/top, 600s archive). The user's vote visibly reverts and nothing re-invalidates until the next writer. Same window swallows freshly crawled videos.
- **BE8 (cache half) — Archive cached as one oversize value.** `readSortedArchive` caches the entire sorted archive in one ~100KB value and swallows the oversize failure; once the archive passes the cache-value limit, caching silently stops. (Retention/pruning is `fix/be-archive-retention`.)

## Approach
1. Extract `cachedSortedList(key, ttlSeconds, producer)` folding `readFeedHead`/`readTopWeek`/`readSortedArchive` (~L2387/L2428/L2151). Reconcile their divergent guards (feed/top validate `total` + scan `expires_at`; archive does neither) into one validated shape.
2. Keep a monotonic **generation** counter in a Script Property. Stamp `gen` into every cached payload at read time. Each `invalidate*` (crawl ~L799/L801, `updateVoteCount` ~L3036, `updateCommentCount` ~L2875, `pruneOldVideos` ~L911) bumps the counter. `cachedSortedList` refuses to serve **or** `put` a payload whose `gen` is behind current — closing the put-after-invalidate window.
3. Route feed-head, top-week, and archive reads through the one helper; delete the three near-duplicate pairs.

## Verification
- Unit test: read → invalidate → simulated late `put`; assert the stale payload is rejected on next read.
- Unit test: vote → next feed read reflects new count (no revert).
- `npm test` backend suite still green against the in-memory sheet stubs.

## Sequencing
Lands before `fix/be-archive-retention` (which builds on the helper's paged archive cache).
