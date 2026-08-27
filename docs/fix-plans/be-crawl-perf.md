# Fix plan: fix/be-crawl-perf

**Phase:** P2 · **Ships via:** deploy skill (clasp) · **Files:** `apps-script/Code.gs`

## Findings closed
- **BE6 — The crawl issues one write RPC per feed item.** `crawlAllFeeds` does `videosSheet.appendRow(newRow)` per new item (~L736), a `setValue` per existing item's view_count (~L747), and a 1×3 `setValues` for the live-status trio (~L762). ~18 channels × ~15 entries ≈ 540 round-trips/crawl; at ~50–150ms each that's 27–80s of the 270s `CRAWL_BUDGET_MS` spent purely on write latency. At 10× channels the budget trips every run and channels refresh only once per resume cycle.
- **BE7 — `getMeta` reads the whole Meta sheet on every call, and `rate_*` rows grow forever.** `getMeta` (~L3506) does a full `getDataRange().getValues()` scan; it's called 3× in `handleFeed` and twice per channel for `youtube_api_key` (~L932, ~L1779). `recordCommentTime` (~L325) appends a `rate_<email>` row per commenter permanently, so every `getMeta` gets slower as users accrue.
- **SEC12 — `rate_*` PII in the Meta config sheet.** Commenter emails sit next to `admin_token`/`youtube_api_key`.

## Approach
1. Accumulate new rows into an array; write once via `getRange(lastRow+1, 1, rows.length, width).setValues(rows)` (and `@`-format that range, completing `fix/be-input-validation-injection`'s BE9). Batch existing-item updates by reading the live-state columns once and writing them back as whole-column ranges.
2. Load Meta once per execution into an object, mirroring the `_cachedLogLevel` memo (~L3541) and `_cachedSessionSecret` pattern. Replace hot-path `getMeta` calls with lookups against it.
3. Move rate stamps out of Meta into `CacheService` with a `RATE_LIMIT_SECONDS` TTL (they're inherently ephemeral) — removes both the PII and the unbounded scan growth. Shares the limiter helper with `fix/be-abuse-rate-limits`.

## Verification
- Backend unit: a crawl with K new items performs one batched `setValues`, not K appends; Meta is read once per execution; no `rate_` rows accrue.
- `npm test` backend suite green.

## Sequencing
Coordinate the Meta→CacheService rate move with `fix/be-abuse-rate-limits` so the limiter lands once.
