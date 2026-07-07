/**
 * config.js — Deployment constants and tuning knobs.
 *
 * One place to point the frontend at a different backend, client ID,
 * or pagination behavior. Imported by every module that needs a knob;
 * nothing here is mutated at runtime.
 */

export const CONFIG = {
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwyt7c8SWw9y0TnKq4RhcV7yLjS1JkXnNThYInpj-EnNYbA3ecgwVSX4gBIACNKHCqu0A/exec',
  GOOGLE_CLIENT_ID: '58088759188-uhqgajeoe8h218h3o6pql634pkcjsu70.apps.googleusercontent.com',
  PAGE_SIZE: 10,
  COMMENT_BATCH_SIZE: 10,     // ids per commentsBatch request (backend caps at 20)
  SEARCH_INDEX_LIMIT: 2000,   // first fetch; if the catalog outgrows it, a
                              // follow-up fetch grabs the rest (see ensureSearchIndex)
  PREFETCH_PAGES_AHEAD: 3,    // pages fetched ahead of the scroll position so
                              // infinite scroll renders instantly from memory
};
