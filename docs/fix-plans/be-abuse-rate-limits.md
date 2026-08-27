# Fix plan: fix/be-abuse-rate-limits

**Phase:** P1 · **Ships via:** deploy skill (clasp) · **Files:** `apps-script/Code.gs`

Theme: unauthenticated / unthrottled paths let one caller burn the daily quota or degrade the site for everyone.

## Findings closed
- **SEC1 / BE4 (auth) — `tokeninfo` fetch per unknown token, never cached.** `verifyGoogleToken` (~L3204) does a live `UrlFetchApp.fetch` to `oauth2.googleapis.com/tokeninfo` for every token it doesn't recognize and deliberately never caches failures; the endpoint is `ANONYMOUS`. A loop of garbage tokens burns the ~20k/day UrlFetch cap — after which sign-in **and** the RSS crawl stop for the day.
- **BE4 (reads) — Unauthenticated callers force the most expensive path.** `handleVideo` on a miss runs `readAllVideos()` **and** `readSortedArchive()` (full scans); `getVideos` skips the cached-head fast path when `start+limit > FEED_HEAD_COUNT` (e.g. `?page=999`). No read endpoint is rate-limited.
- **BE5 / SEC3 — Votes/stars take the global lock through two full sheet scans, with no rate limit.** `handleVote` locks, then `updateVoteCount` (~L3000) re-reads the entire Votes **and** Videos sheets; only comments are rate-limited. One account toggling a vote in a loop serializes all writes and drops caches every toggle.
- **BE11 — `handleTopWeek` clamps neither page nor limit; no endpoint caps `limit`.** `?page=-1` yields `slice(-100,-50)`; `&limit=100000` serializes the whole catalog.
- **SEC5 — `clientError` has only a *global* budget.** `'cerr_'+minute` is one counter; 60 reports/min permanently drops every real user's telemetry.

## Approach
1. `verifyGoogleToken`: locally decode + validate `aud` (=== `GOOGLE_CLIENT_ID`), `iss`, `exp` before the network call; bail on mismatch with no fetch. Negatively cache failed token hashes (`tok_`-style key) ~60s.
2. Rate-limit `handleVote`/`handleStar` reusing the comment limiter, moved to `CacheService` (see `fix/be-crawl-perf` for the Meta→cache move) with a short window (~2s/user). Maintain `vote_count` incrementally (±1 on the known row) instead of the full recount in `updateVoteCount`.
3. Clamp `page = Math.max(1, page)` in `handleTopWeek` (~L2529); cap `limit` to ≤100 in `getVideos`/`handleTopWeek`/`handleArchive`. Cache a `videoId→not-found` marker in `handleVideo` (~L2230) so repeated misses don't rescan.
4. `clientError`: budget per `sessionId` **and** globally; add a Meta kill-switch key.

## Verification
- Unit: garbage-token path performs **no** `UrlFetchApp` call; clamps reject negative/oversized page & limit; not-found marker short-circuits a second lookup.
- Load-style unit: N vote toggles don't rescan the whole sheet (incremental count).

## Sequencing
After `fix/be-input-validation-injection`. The Meta→CacheService rate-stamp move is shared with `fix/be-crawl-perf` — coordinate so the limiter helper lands once.
