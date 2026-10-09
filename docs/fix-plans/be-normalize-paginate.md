# Fix plan: fix/be-normalize-paginate

**Phase:** P2 · **Ships via:** deploy skill (clasp) · **Files:** `apps-script/Code.gs`, `apps-script/appsscript.json`

## Findings closed
- **BE10 — `normalizeVideoRows` hardcodes `video_id` while the rest supports `item_id`.** `findVideoIdCol` (~L140) and `crawlAllFeeds` (~L622) accept an `item_id` header (crawl prefers it), but `normalizeVideoRows` (~L2092), `dedupeByUrl` (~L2264), `compareVideos` (~L2289), `cursorFor` (~L2296), and `handleVideo` read `video.video_id` directly. On an `item_id`-headed sheet, `video_id` is `undefined`: `dedupeByUrl` collapses url-less rows under `'id:undefined'`, `next_cursor` becomes `"…|undefined"`, `?v=<id>` deep links return null, and the sort tiebreak degenerates so cursor pagination can skip/repeat.
- **BE13 — Empty Videos sheet bootstrap writes headerless rows.** A blank sheet reads as `[['']]`, coerced to `[]` (~L598); the self-init column adds are guarded by `length > 0`, so an empty sheet takes the hardcoded 13-column fallback append (~L708–712) which never writes a header row and omits the `live_status`/`scheduled_start`/`expires_at` trio. `normalizeVideoRows` then treats the first video row as the header, keying every field by that video's own title/url; the next crawl overwrites a data cell with the literal `view_count`.
- **BE14 — `handleGetChannels` copies every column.** `~L551–553` does `channel[headers[j]] = row[j]` for all columns; any operator-added column (notes, contact, a per-channel key) is published to the anonymous response the moment it's created.
- **BE12 — Manifest omits `script.scriptapp` scope.** `appsscript.json` declares only `spreadsheets` + `script.external_request`; `scheduleRefresh` uses `ScriptApp.newTrigger`/`getProjectTriggers` (needs `script.scriptapp`). The explicit list isn't auto-expanded, and `scheduleRefresh`'s catch swallows the permission error → the auto-refresh silently never runs.

## Approach
1. In `normalizeVideoRows`, resolve the id column via `findVideoIdCol(headers)` and assign it to `video.video_id` so downstream code is unaffected by an `item_id` header.
2. Write the canonical header row before the first append when the sheet is empty, then fall through to the normal header-driven path (drop the hardcoded fallback, or have it write the header first).
3. `handleGetChannels`: whitelist the fields the frontend renders (name, url, avatar, tier, category) instead of copying all columns.
4. Add `https://www.googleapis.com/auth/script.scriptapp` to `oauthScopes`; raise the `scheduleRefresh` failure to an ERROR log with the exception name so it's not invisible.

## Verification
- Backend unit: an `item_id`-headed fixture yields populated `video_id`, correct dedupe/cursor, and a resolvable `?v=<id>`.
- Backend unit: bootstrapping an empty sheet writes a header row first; a second crawl doesn't corrupt cell values.
- Confirm the channels response contains only whitelisted keys.
- After deploy, verify the refresh trigger actually registers (project triggers list).
