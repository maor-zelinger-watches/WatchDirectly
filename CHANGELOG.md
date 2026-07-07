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
