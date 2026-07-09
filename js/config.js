/**
 * config.js — Deployment constants and tuning knobs.
 *
 * One place to point the frontend at a different backend, client ID,
 * or pagination behavior. Imported by every module that needs a knob;
 * nothing here is mutated at runtime.
 */

export const CONFIG = {
  APP_VERSION: '1.15.0',      // frontend version (npm semver) — bump on every
                              // user-visible change; shown in the header and
                              // logged at boot. Backend has its own VERSION
                              // in apps-script/Code.gs; package.json tracks
                              // the repo/tooling. See CHANGELOG.md.
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwyt7c8SWw9y0TnKq4RhcV7yLjS1JkXnNThYInpj-EnNYbA3ecgwVSX4gBIACNKHCqu0A/exec',
  GOOGLE_CLIENT_ID: '58088759188-uhqgajeoe8h218h3o6pql634pkcjsu70.apps.googleusercontent.com',
  PAGE_SIZE: 10,
  COMMENT_BATCH_SIZE: 10,     // ids per commentsBatch request (backend caps at 20)
  SEARCH_CHUNK_SIZE: 500,     // page size for building the search index; the
                              // catalog is fetched in parallel chunks of this
                              // size so results paint as each chunk lands
  SEARCH_RENDER_LIMIT: 200,   // max cards painted for a filtered render — a
                              // broad query (e.g. a single letter) can match
                              // nearly the whole index, and building thousands
                              // of cards synchronously freezes the page
  SEARCH_INDEX_LIMIT: 5000,   // absolute ceiling on indexed/cached items — a
                              // backstop against an unbounded sheet, not a
                              // normal limit (see ensureSearchIndex)
  PREFETCH_PAGES_AHEAD: 3,    // pages fetched ahead of the scroll position so
                              // infinite scroll renders instantly from memory
  TYPE_FILTER_MIN_CARDS: 20,  // when the content-type chips leave fewer than
                              // this many matching items loaded, more pages
                              // are pulled automatically (Latest feed only)
  TYPE_FILTER_TOP_UP_MAX_PAGES: 10, // per-interaction cap on those automatic
                              // pulls — a near-empty type must not fetch the
                              // whole catalog in one burst; scrolling (or the
                              // next chip click) continues from where it left off
};
