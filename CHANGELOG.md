# Changelog

Every part of WatchDirectly carries its own [semver](https://semver.org/)
version (npm scheme: MAJOR.MINOR.PATCH), so progress can be followed per
component:

| Component | Version lives in | Visible at |
|---|---|---|
| Frontend | `APP_VERSION` in [js/config.js](js/config.js) | header badge + browser console at boot |
| Backend (Apps Script) | `VERSION` in [apps-script/Code.gs](apps-script/Code.gs) | `version` field on every API response, and `?action=version`; also in the clasp deployment description |
| Repo / tooling | `version` in [package.json](package.json) | `npm pkg get version` |

Bump rules (npm scheme):

- **PATCH** (1.0.x) — bug fixes, no behavior change callers notice
- **MINOR** (1.x.0) — new features, backwards compatible
- **MAJOR** (x.0.0) — breaking changes (e.g. API response shape changes)

When you change a component, bump its version and add an entry below under
that component's heading.

## Frontend

### 1.15.0 — 2026-07-09
- **Invisible auth refresh.** Opening the site after the ~1-hour Google ID-token
  expiry used to flash the Google One Tap overlay and repaint the header, because
  the boot reconcile eagerly called `refreshToken()`, which re-mounted One Tap.
  Now, on first sign-in the client exchanges the Google ID token for a long-lived
  app **session token** (`api.createSession`, backend `session` action) and stores
  that as `currentUser.token`. Session tokens carry a 30-day sliding expiry, so a
  returning visitor's token is still valid on open — no refresh, no overlay, no
  repaint. When a token does near expiry, `auth.js` slides it forward with a
  **silent** `fetch` (`maybeSlideSession` / `refreshToken`), never the interactive
  One Tap; One Tap is now a last resort only if the session lapses entirely
  (an absence longer than the session lifetime). `isTokenExpired` decodes either
  token format; `updateAuthUI` is idempotent so a token rotation can't repaint the
  avatar. Falls back to the raw Google token if the exchange fails, so sign-in
  degrades gracefully against an older backend. Requires backend ≥ 1.8.0.

### 1.14.0 — 2026-07-08
- The content-type filter now defaults to **Videos + Articles** (Shorts hidden)
  for a first-time visitor, and the selection **persists across sessions** in
  localStorage (`wd_filter_types`). Whatever chips a user leaves selected come
  back on their next visit; choosing **All** is remembered as All (stored as
  `[]`, kept distinct from "never chose" so the default only applies to genuine
  first-timers). Restored on chip render over the state default; saved on every
  chip toggle. Corrupt or unknown-value payloads self-heal to the default, in
  keeping with the rest of `cache.js`.

### 1.13.0 — 2026-07-08
- Extended stale-while-revalidate caching to every tab, so navigating and
  refreshing paint instantly from localStorage and reconcile in the background
  — the same model the Latest feed uses. Each tab reconciles to fit its data
  shape:
  - **Top This Week** (`wd_top_cache`): the first ranked page is cached and
    repainted instantly on open/refresh, then a background refetch reconciles
    that window — new items in, dropped items out, order and counts updated
    (`mergeTopRanking`). Deeper pages the user scrolled to are preserved: a
    page-1 refetch knows nothing about them, so absence there isn't deletion.
    Verified painting from cache in ~26 ms with no skeleton.
  - **Favorites**: now paints instantly from the already-persisted search
    index (the full catalog) filtered by starred creators, and reconciles as
    fresh catalog chunks stream in — instead of blocking on a full index build
    behind a skeleton. Guards the empty state so a partial seed never flashes
    "no favorites" while the catalog is still loading.
  - **Channels** (`wd_channels`): the small curated list is fully cached and
    repainted instantly, revalidated by full replace, and only re-rendered when
    the list actually changed (no flash on an unchanged open). Verified painting
    from cache in ~60 ms.
- Fixed Latest feed caching so a refresh restores from localStorage instead of
  re-fetching everything from the backend. Two bugs were defeating the
  stale-while-revalidate cache:
  - **First-load cache was never written when the follow-up fetch stalled.**
    Initial load fetches page 1 in two steps (a fast N+1 paint, then the full
    page), but `saveFeedCache` only ran after the second fetch. When that
    request was slow or failed (Apps Script cold-starts routinely do),
    execution fell into the `catch` and the cache stayed empty — so the next
    refresh found nothing and showed the loading skeleton. The page-1 snapshot
    is now saved from the first fetch; the second upgrades it.
  - **Scrolled-through pages weren't cached, and revalidate wiped them.** The
    infinite-scroll path never rewrote the cache (only page 1, votes, and
    comments did), so pages 2+ were lost on refresh. And even with them cached,
    `revalidateFeed` replaced the feed with fresh page 1 and animated out every
    card missing from it — deleting the whole scrolled tail (items absent from
    page 1 are pushed-down, not deleted). Pagination now persists the growing
    feed, and revalidate reconciles a multi-page feed non-destructively: it
    adds new top items and updates counts but keeps the tail. A genuinely
    deleted item lingers in the cached tail until a full re-navigation — an
    acceptable trade for restoring the scrolled feed instantly across refresh.

### 1.12.0 — 2026-07-08
- Removed `creators.json`: the Channels tab and search's host-name matching now
  fetch the curated creator list from the backend's new `getChannels` action
  (requires backend ≥ 1.6.0) instead of a static JSON file shipped with the
  frontend. `loadCreators()` calls `api.fetchChannels()` in place of
  `fetch('./creators.json')`; the shape consumed by `createChannelCard` and the
  host map is unchanged, so no other frontend code moved. Keeping creator
  metadata (host, avatar, focus, etc.) in the same CHANNELS sheet the backend
  already reads for crawling means one source of truth instead of two that
  could drift.

### 1.11.0 — 2026-07-08
- Nebula-style feed grid: the video/article feed now tiles up to **three across
  on desktop** (two on tablet, one on mobile) instead of a single column of
  wide, horizontal cards. Each card became a vertical tile — 16:9 thumbnail on
  top, title/meta/action-bar stacked below — by switching `.media-card__grid`
  from a `280px | content` row to a single column, and `.feed` from a flex
  column to a responsive CSS grid. The desktop canvas widens (`--max-width`
  860 → 1120px) so three tiles get ~355px each. Titles reserve two lines so
  tile bottoms line up across a row, and `align-items: start` means expanding a
  card's inline comments grows only that card, never its row-mates. Pure CSS —
  no markup or JS change — so Latest, Top This Week, Favorites and search
  results all inherit the grid, and the Channels grid and fullscreen overlay
  are unaffected.

### 1.10.0 — 2026-07-08
- **Top This Week** now infinite-scrolls instead of showing a fixed first
  slice. The tab was capped at a single 50-item response; because votes are
  sparse the ranking degrades to reverse-chronological, so that cap only ever
  reached the newest ~2 days of a busy week. The tab now paginates by cursor
  like the Latest feed — `fetchTopWeek` takes the previous response's
  `next_cursor`, `switchView` loads the first page and `loadMoreTop` appends
  the rest in rank order as you scroll (new `state.topCursor` / `topLoading` /
  `topHasMore` / `topTotal`). The shared infinite-scroll observer routes to the
  active tab's loader. A search query still pauses pagination and filters the
  loaded set, exactly as on Latest; appended cards inherit the content-type
  chips' CSS visibility automatically. Requires backend ≥ 1.5.0 for the deep
  pages; against an older backend the tab simply shows the first page as before.

### 1.9.0 — 2026-07-08
- New **Channels** feed tab (after Favorites): a three-up grid of every curated
  creator, each card showing the channel's avatar, its name (linking to the
  channel on YouTube), and a favorite ☆. The star reuses the existing
  media-card star machinery — same `media-card__star` class and `data-channel`
  hook — so favoriting here toggles, persists, reconciles on sign-in, and syncs
  with the video cards' stars with no change to the star engine; a creator
  favorited on this tab immediately populates the Favorites feed. Browsing the
  grid needs no sign-in (favoriting does, which the existing gate enforces).
  Avatars come from a new `avatar` field on each creator in `creators.json`
  (see the repo's `fetch-avatars` script), down-requested to display size at
  render time, and fall back to a monogram tile when absent or if the image
  fails to load. The grid collapses to two columns under 640px; the video
  search/type controls hide on this tab since they filter videos, not channels.

### 1.8.0 — 2026-07-08
- Added a sticky footer, fixed to the bottom of the viewport, mirroring the
  existing sticky header (same blur/border, `z-index: 100` so it tucks under the
  fullscreen overlay). The Terms/Privacy nav — and the version badge on the home
  page — moved out of the header and into the footer, leaving the header with just
  the logo and auth button. Applies to `index.html`, `terms.html`, and
  `privacy.html`; active-link highlighting is preserved on the legal pages.
- The footer carries a copyright line whose year is set at runtime from
  `new Date().getFullYear()`, so it rolls over automatically each January (a small
  inline script sets it, since the legal pages don't load `app.js`).
- Page content now reacts to the footer instead of hiding behind it: `<body>`
  gains `padding-bottom: var(--footer-height)` and `.main`'s `min-height` subtracts
  both bars, so the last card / legal section always ends above the footer and a
  short page gains no spurious scroll. Removed the now-dead `.header__nav*` CSS.

### 1.7.1 — 2026-07-08
- Toaster notifications now linger 30% longer (3.0s → 3.9s) so messages are
  easier to catch before they fade. The `toastOut` fade animation delay moves in
  step (2.7s → 3.6s) to stay synced with the DOM removal, so the fade still lands
  exactly as the toast leaves.
- Finished the star→favorite copy rename started in 1.6.1. The signed-out prompt
  now reads "Please sign in to favorite creators", and each creator's ☆ button
  shows a "Favorite this creator" tooltip and "Favorite <channel>" screen-reader
  label. The ☆/★ glyphs and internal identifiers (`myStars`, `toggleStar`) are
  unchanged, so no data or backend change is needed.

### 1.7.0 — 2026-07-08
- One video at a time: starting an inline player now pauses whichever other
  player was running, so two soundtracks no longer overlap. Each YouTube embed
  gains `enablejsapi=1`; a new `single-play.js` registers each player as a
  listener on load and, when one reports it started playing, sends `pauseVideo`
  to the rest. It's a **pause**, not a stop — the paused video keeps its place
  and resumes on tap — and fullscreen is deliberately untouched, so expanding a
  card leaves it playing. Verified live against real YouTube players.

### 1.6.1 — 2026-07-07
- Renamed the "Starred" feed tab to **Favorite** (the ☆/★ icons are unchanged).
  The empty-state and error copy for the feed now read "favorite creators" to
  match. Internal identifiers (`data-view="starred"`, the `star`/`myStars` API
  actions, localStorage keys) are untouched, so no data migration or backend
  change is needed.

### 1.6.0 — 2026-07-07
- Removed the category tag from media cards. The `.media-card__category` chip (and
  its `.media-card__tags` wrapper) added visual noise without earning its space —
  the channel and time already frame each item — so it's gone from the markup and
  the stylesheet.
- The header nav now scrolls horizontally instead of wrapping when the links
  overflow on narrow viewports: `.header__nav` gains momentum touch-scroll with a
  hidden scrollbar, and links no longer shrink or wrap. Keeps the header a single
  clean row on mobile.

### 1.5.0 — 2026-07-07
- Rebranded the UI to the Andrew Morgan Watches design system: swapped the type
  from Inter to **Poppins** (across the app and the Terms/Privacy pages) and
  remapped the palette to a pure-black canvas (`#000`), off-black cards
  (`#0d0d0d`–`#161616`), pure-white text, slate-grey metadata, and a single
  electric **volt-chartreuse** accent (`#e1f003`) replacing the former gold. The
  wordmark and feed tabs are now uppercase with editorial letter-spacing.
- Reworked buttons into the guide's outlined-pill system (2px borders, uppercase
  labels, 8px radius): the primary CTA is solid chartreuse, and the secondary
  (`.btn--ghost`) is a white outline that inverts to a white fill on hover —
  deliberately not the accent, keeping the neon rare so it reads loudest on the
  one primary action per view. Added an unused `--orange` (`#c7632f`) token
  reserved for the logo per the brand guide.

### 1.4.0 — 2026-07-07
- Search no longer flashes blank on the first keystroke. The first query paints
  against an in-memory seed (the pages scrolled so far) while the full catalog
  index streams in behind it — but when the seed had no match, the container was
  cleared to zero cards and, since that pass isn't final, the empty state stayed
  hidden, leaving a visible blank until the network chunks landed. A new
  "Searching…" indicator (`#feed-searching`) now shows whenever there are no
  matches to paint *and* the index is still building, so the box never goes
  blank; it resolves to real results or the "No videos match" empty state once
  the index completes, and clears on tab switch so it can't strand under another
  view.
- Tightened the search debounce from 250ms to 120ms. Matching is in-memory and
  the render is capped, so the main thread keeps up per keystroke; the first
  keystroke now feels responsive instead of laggy.

### 1.3.1 — 2026-07-07
- Toast notifications are now larger and anchored to the top-center of the
  viewport instead of the bottom. Bigger type (18px, semibold), roomier
  padding, a wider max-width, and a drop shadow make transient messages
  easier to notice; the entrance animation now slides down from the top to
  match the new position.

### 1.3.0 — 2026-07-07
- Sign-in now reconciles votes and stars in a single `bootstrap` request
  instead of two back-to-back POSTs. Apps Script serializes a user's requests,
  so the old pair queued nose-to-tail on load (and each re-verified the ID
  token over the network); the batched call halves both the boot-time queue
  depth and the token checks. The new `bootstrap.js` hands the one request
  promise to both the vote and star reconcilers, which each still capture their
  own epoch before awaiting — a vote/star toggled mid-flight still wins.

### 1.2.1 — 2026-07-07
- Feed batches now insert in a single synchronous DOM pass — layout settles
  in one frame instead of shifting for ~1s per page while cards trickled in
  on timers (clicks kept landing on a moving page). The staggered entrance
  reveal looks the same but runs compositor-only via per-card CSS
  `animation-delay` (long-form first, Shorts fade in after at their
  chronological position), so it causes zero layout shift.
- Scroll targets no longer land underneath the sticky header: a universal
  `scroll-margin-top` means keyboard focus (Tab) and `scrollIntoView` leave
  chips, vote/star/expand buttons and cards below the header instead of
  burying them where taps hit the header. Generalizes the fix `.media-card`
  already had for the post-fullscreen scroll restore.

### 1.2.0 — 2026-07-07
- Content-type chips are now pure UI visibility filters (CSS hide/show over
  already-rendered cards) instead of re-rendering through the search index —
  a type-only filter matched most of the catalog and painting thousands of
  cards per click froze the app. Cards carry `data-media-type`; deselected
  types get a `feed--hide-<type>` class on the feed container.
- Pagination and infinite scroll keep running under a type filter, and a new
  top-up setting (`TYPE_FILTER_MIN_CARDS: 20`) automatically pulls more pages
  when the filtered Latest feed has fewer than 20 matching items (bounded by
  `TYPE_FILTER_TOP_UP_MAX_PAGES` per interaction).

### 1.1.0 — 2026-07-07
- Replaced the creator-category chips and the Shorts on/off toggle with a
  multi-select content-type filter: **All / Videos / Articles / Shorts**.
  "All" is exclusive; picking a type clears it; selecting every type (or
  deselecting the last one) collapses back to "All". Deferred shorts
  rendering (long-form first, shorts slide in) is unchanged.

### 1.0.0 — 2026-07-07
- Initial versioned release. Paginated chronological feed with
  stale-while-revalidate caching, fuzzy full-catalog search, Top This Week
  and Starred views, inline comments, votes, stars, Shorts toggle,
  fullscreen watch-and-discuss overlay, Google Sign-In.

## Backend

### 1.8.0 — 2026-07-09
- **App-issued session tokens**, so the frontend can re-authenticate silently
  instead of re-invoking Google One Tap. New `session` POST action mints an
  HMAC-SHA256-signed token (`wds1.<base64url(payload)>.<sig>`) after verifying the
  caller once; the same action renews a still-valid session token, so a returning
  visitor never needs Google again until the 30-day (`SESSION_TTL_DAYS`) window
  fully lapses. All six authenticated handlers now go through `authenticateUser`,
  which accepts **either** a session token (local HMAC check — no `tokeninfo`
  round trip, so also faster) or a Google ID token (unchanged path), keeping old
  and new clients working during rollout. The signing secret is auto-generated
  into Script Properties on first use (`getSessionSecret`, CSPRNG-backed
  `Utilities.getUuid` ×2); `verifySessionToken` recomputes the HMAC with a
  constant-time compare and enforces `exp` independently of the signature. Ship
  this **before** frontend 1.15.0. Run `runSessionSelfTest()` in the editor once
  after deploy to validate the crypto and materialize the secret before traffic.

### 1.7.0 — 2026-07-08
- `getChannels` now falls back to a favicon for news/article outlets that have
  no `avatar` set — those channels have no YouTube channel page to scrape a
  logo from the way `populateChannelAvatars` did for video creators. When a
  channel's `avatar` is blank and its `url` isn't a `youtube.com`/`youtu.be`
  link, the new `extractDomain` helper pulls the registrable domain and builds
  `https://www.google.com/s2/favicons?domain=<domain>&sz=128` (Google's public
  s2 favicon service). YouTube channels are left alone — a generic YouTube
  favicon would be a worse fallback than the Channels-tab monogram they
  already get.

### 1.6.0 — 2026-07-08
- New `getChannels` action serves the curated creator list straight from the
  CHANNELS sheet — the same sheet `crawlAllFeeds` already reads to know which
  feeds to poll — so the frontend no longer needs its own copy in
  `creators.json`. Returns every enabled row as an object keyed by column
  header (`channel_name`, `host`, `url`, `avatar`, etc.), skipping disabled
  channels the same way the crawler does. A one-time `populateChannelAvatars`
  in `Setup.gs` backfills the sheet's new `avatar` column from the data that
  used to live in `creators.json`.

### 1.5.0 — 2026-07-08
- `handleTopWeek` is now cursor-paginated, mirroring `getVideos`. It still
  ranks the rolling 7-day window by upvotes (newest, then `video_id`, as
  deterministic tiebreaks — the tiebreak is what keeps a cursor from skipping
  or repeating items whose votes and timestamps collide), but it now accepts
  `page`/`cursor` and returns a `next_cursor`. Early no-cursor pages are served
  from the cached ranked head (still 50 rows, 5-min TTL); deeper pages resume
  strictly after the `(vote_count, published_at, video_id)` position the client
  last saw via a live sorted scan — so the WHOLE week is reachable by scrolling
  even though the cache only holds the head, without materializing a second
  sheet or re-scanning per request for the common early pages. A vote that
  reorders the window mid-scroll can at worst nudge one item across a page
  boundary (the client dedupes), never skip a page the way an offset would.
  Backwards compatible: a no-cursor request (e.g. an older client's
  `limit=50`) returns the first page exactly as before, now with an ignored
  `next_cursor` field alongside.

### 1.4.0 — 2026-07-08
- Each crawl now refreshes the live YouTube view count for every video still in
  the feed. The channel `videos.xml` RSS feed only lists a channel's ~15 most
  recent uploads and no longer carries a dependable `media:community` view count,
  so counts were effectively frozen at ingest. `enrichLiveMetadata` — the single
  batched `videos.list` call the crawl already makes for premiere/live state —
  now also requests `part=statistics` and writes `statistics.viewCount` back to
  the Videos sheet's `view_count` column (both at first ingest and on every
  re-crawl). Adding a part costs no extra quota (videos.list is 1 unit per call).
  Because only videos still inside the ~15-entry RSS window are fetched, a
  video's count stops updating once it drops out of the feed — it keeps its last
  recorded value. Degrades cleanly with no key or on an API error (count left as
  ingested), and items that hide their stats keep their existing count.

### 1.3.0 — 2026-07-08
- Top-week cache: `handleTopWeek` now serves the ranked last-7-days window from
  `CacheService` (50 rows, 5 min TTL) instead of rescanning the whole Videos
  sheet on every request. The window logic was always a rolling 7 days ranked by
  upvotes, but `readAllVideos` scanned the full, ever-growing sheet live on each
  open — the read-only cost that once timed the request out. Populated
  read-through on a cache miss; explicitly invalidated by the same writers that
  drop the feed head (crawl completion, vote recounts, comment recounts) so the
  ranking and counts stay live. A request larger than the cached slice falls
  through to a live scan, and a cached window holding an expired premiere/live
  entry is treated as a miss rather than served stale.

### 1.2.0 — 2026-07-07
- Feed requests no longer crawl inline. `handleFeed` used to run the full
  `fetchAllFeeds` crawl (14 feeds, per-channel sleeps, retry backoff, YouTube
  enrichment — tens of seconds) whenever the feed was stale. Because Apps
  Script serializes a user's web requests, that stalled every other request the
  page fired on load behind it, surfacing as 30s+ TTFBs even though each
  execution was individually fast. Now a stale feed is served immediately and
  the crawl is handed to its own execution via a one-shot `kickoffRefresh`
  time-based trigger (guarded against pile-up by the `fetch_in_progress` marker
  and a pending-trigger check). Responses carry `stale: true` while a refresh is
  underway. Matches the read-only design `handleTopWeek` already had.
- New `bootstrap` POST action returns a signed-in user's upvoted video ids and
  starred channels together, verifying the token once — replacing the separate
  `myVotes` + `myStars` calls (both kept for older clients).
- Token verification is now cached in `CacheService` keyed by a hash of the ID
  token, so repeat calls in a short window (bootstrap, then rapid votes/stars)
  skip the ~100-500ms `tokeninfo` round trip. TTL is capped at the token's own
  expiry; failures are never cached.
- Feed-head cache: the first 50 sorted videos are kept in `CacheService`
  (5 min TTL), so the requests that gate a cold start's first paint (page 1,
  its completion, early prefetch pages) skip the full Videos-sheet scan + sort
  and answer in a cache read. Populated read-through by any full-path feed
  request; explicitly invalidated by every writer that changes what the head
  contains (crawl completion, vote recounts, comment recounts), so counts stay
  live. Cursor requests and deep pages always take the live path, and a cached
  head holding an expired premiere/live entry is treated as a miss.

### 1.1.0 — 2026-07-07
- Pull premieres and scheduled/active live streams. RSS entries for these are
  indistinguishable from normal uploads (no broadcast state, no air time), so
  the crawl now enriches each YouTube item via the Data API `videos.list`
  (`part=snippet,liveStreamingDetails`, 50 ids/call) into three self-initialized
  columns: `live_status` (`upcoming`/`live`/`none`), `scheduled_start`, and
  `expires_at`. A premiere/live entry gets an `expires_at` (scheduled start, or
  ingest time, + 12h grace); once it airs it keeps the **same** video id and the
  existing row is re-enriched in place to `none` with `expires_at` cleared —
  becoming permanent. `readAllVideos` drops rows whose `expires_at` has passed,
  so an entry that never airs expires out instead of lingering. Requires a
  `youtube_api_key` Meta value; without one the crawl is unchanged.

### 1.0.0 — 2026-07-07
- Initial versioned release. Google Apps Script web app over Sheets:
  feed/comments/topWeek/refresh/logs GET actions,
  comment/vote/star POST actions, token verification, rate limiting,
  blocklist. Adds `version` stamp on all responses and `?action=version`.

## Repo

### 1.2.0 — 2026-07-08
- Removed the `resolve-channels` and `fetch-avatars` maintenance scripts and
  their npm scripts — both existed only to maintain `creators.json`, which is
  gone now that creator metadata lives in the CHANNELS sheet (see Frontend
  1.12.0 / Backend 1.6.0).
- Playwright config hardening: CI now retries flaky live/API-backed suites
  (`retries: 2`) while local runs stay at 0 so a flake is seen, not silently
  retried away; CI pins to a single worker for reproducible timing while dev
  machines parallelize freely; added `forbidOnly` on CI to catch an
  accidentally-committed `test.only`; trace/screenshot capture is now
  failure-only to keep local runs cheap; and the HTML report now writes
  outside `outputDir` so the reporter's own directory wipe can't clobber
  trace/video artifacts. The perf project explicitly pins `retries: 0` — a
  retried run is a fresh timing sample, not the same test.
- `tests/perf/helpers.js`: removed the `timed()` wall-clock stopwatch helper.
  Perf assertions now express a budget as a native Playwright assertion
  timeout (e.g. `expect(...).toPass({ timeout })`) instead of manually timing
  with `Date.now()` and asserting on the delta — the native form fails with a
  clearer message and doesn't race the event loop the way a manual stopwatch
  can.

### 1.1.7 — 2026-07-08
- Deploys are now **skill-only**: removed the post-commit auto-deploy hook so a
  commit never ships anything. `setup:deploy` no longer installs a hook (and
  removes any legacy one); the backend goes live only when the deploy skill runs
  the release gate and then calls `npm run deploy:backend` explicitly. This
  followed an incident where committing a work-in-progress backend auto-shipped
  it. Comments in `deploy-backend.sh` updated to match.
- New release gate `npm run validate:release` (`scripts/validate-release.js`):
  compares the working tree against `origin/main` and blocks unless every changed
  Frontend/Backend component was version-bumped and has a dated CHANGELOG entry;
  a changed repo/tooling version is a non-blocking warning. The deploy skill runs
  it before committing.
- `setup:deploy` hardening: it now probes a stored `~/.clasprc.json` with a real
  authenticated call and re-runs `clasp login` when the token is stale (the
  periodic Google `invalid_rapt` re-auth that silently broke unattended deploys),
  and honors `CLASP_CREDS` to log in with your own published OAuth client for
  long-lived tokens. `.gitignore` now excludes `.clasprc.json` and
  `*client_secret*.json` so credentials can't be committed.

### 1.1.6 — 2026-07-08
- New `fetch-avatars` script (`npm run fetch-avatars`) resolves each creator's
  YouTube channel avatar into an `avatar` field on `creators.json` by scraping
  the channel page's Open Graph image — no API key required (`--force`
  re-fetches all). Backs the Channels tab.
- Test coverage for the Channels tab: `tests/unit/channels.test.js`
  (`createChannelCard` avatar/monogram/name/star markup and the `avatarUrl`
  size rewrite) and `tests/e2e/channels_tab.spec.js` (grid renders from
  `creators.json`, the signed-out favorite gate, the pre-marked signed-in star,
  and the star-here-shows-in-Favorites integration).

### 1.1.5 — 2026-07-08
- Added test coverage for the single-play feature: `tests/unit/single-play.test.js`
  (message parsing, the listening handshake, pause-others-not-self, no `stopVideo`,
  origin/state guards) and `tests/e2e/lazy_iframe.spec.js`, which pins down that a
  below-the-fold player promotes on scroll — on fresh load and after a
  revalidation diff — the lazy-load behavior single-play relies on.

### 1.1.4 — 2026-07-07
- Updated the Starred-tab e2e spec for the "Favorite" rename: the tab is now
  selected by its new visible text and the empty-state assertion matches the new
  "no favorite creators" copy.

### 1.1.3 — 2026-07-07
- Updated the feed unit test for the removed category chip: it now asserts the
  card renders neither the `media-card__category` class nor the category text,
  instead of asserting the category appears.

### 1.1.2 — 2026-07-07
- Search e2e now covers the loading state: a delayed index-build fetch proves
  the "Searching…" indicator shows while the catalog warms and the empty state
  stays hidden, then it settles to the real "No videos match" state once the
  index completes. Updated the filter/search perf comment for the 120ms
  debounce.

### 1.1.1 — 2026-07-07
- Backend unit tests cover the read-only `handleFeed` (serves without crawling
  inline, schedules a one-shot refresh trigger, no double-scheduling), the
  batched `handleBootstrap` action, and `verifyGoogleToken` cache behavior
  (hit skips the tokeninfo fetch, expired entries are re-verified, failures are
  not cached). The `votes_tab` e2e now routes the `bootstrap` action.
- Feed-head cache tests: repeat page-1 requests skip the sheet scan, cursor
  requests take the live path, vote/comment recounts invalidate, and a cached
  head holding an expired premiere is a miss.

### 1.1.0 — 2026-07-07
- New performance test suite (`tests/perf/`, `npm run test:perf`): 16
  user-journey latency tests against a fully mocked backend (cold/warm load,
  revalidation non-blocking, prefetch consumption, scroll jank via longtask
  observer, chip filters, progressive search, tab switches, fullscreen,
  optimistic votes, a full multi-stage journey, and a CPU/network-throttled
  mobile variant). Runs as its own Playwright project, serially — latency
  measured under 16-way parallelism is noise. E2E projects now skip
  `tests/perf/`; the suite holds to the same 30s/test and 5s/action
  standards as e2e.

### 1.0.0 — 2026-07-07
- Initial versioned release. Vitest unit tests, Playwright e2e tests,
  channel resolution script, clasp-based backend auto-deploy.
