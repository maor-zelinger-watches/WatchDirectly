# Fix plan: fix/be-archive-retention

**Phase:** P2 · **Ships via:** deploy skill (clasp) · **Files:** `apps-script/Code.gs`

**Depends on** `fix/be-cache-generation-helper` (uses its paged cache helper).

## Finding closed
- **BE8 (retention half) — The Archive tab is never pruned and outgrows its cache.** `pruneOldVideos` only ever *appends* to the Archive tab (`getRange(...).setValues(archive)`); nothing removes Archive rows. `readSortedArchive` caches the entire sorted archive in one ~100KB value and does a full `getDataRange().getValues()` + normalize + dedupe + sort **per page** on a miss. Once the archive passes the cache-value limit (a few hundred items) caching silently stops, and the frontend's multi-page index build fires N sequential requests each paying a full growing scan+sort — the first thing to hit the 6-minute execution cap at 10× content, and eventually the 10M-cell spreadsheet limit.

## Approach
1. Cache the archive **by page** (or a compact `{id,title,url}` projection) keyed by page number, via the `cachedSortedList` helper — so a single oversize value can't disable caching.
2. Add a second-stage retention that drops or off-loads Archive rows past a hard age (extend `PRUNE_AFTER_DAYS`-style config with an archive-max-age), so the tab is bounded.
3. Ensure retention invalidates the paged archive cache (generation bump from `fix/be-cache-generation-helper`).

## Verification
- Backend unit: paged archive read serves page N without scanning the whole tab; retention removes rows past the age cap and bumps the cache generation.
- Confirm archive paging stays constant-time as the tab grows in the fixture.
