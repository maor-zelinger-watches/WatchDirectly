/**
 * Shared helpers for the performance suite (tests/perf).
 *
 * These tests measure *interaction latency the way a user experiences it* —
 * time from an action (load, scroll, chip click, keystroke, tab switch,
 * expand) to the moment the UI has visibly responded — against a mocked
 * backend so timings are deterministic and not hostage to the real network.
 *
 * Two kinds of assertion are used, and both matter:
 *   1. Latency budgets — an interaction must settle within N ms.
 *   2. Architecture invariants — the interaction must NOT do the expensive
 *      thing (fire a network request, re-render the whole feed, drop state).
 *      A fast machine can pass a loose budget while silently regressing the
 *      design; the invariant catches that.
 *
 * Budgets are deliberately generous relative to a warm local run (they must
 * pass on a loaded CI box too) while still being far below the "feels laggy"
 * threshold they guard.
 */

// Mirror of the tuning knobs in js/config.js the tests reason about.
export const PAGE_SIZE = 10;
export const PREFETCH_PAGES_AHEAD = 3;
export const TYPE_FILTER_MIN_CARDS = 20;
export const SEARCH_CHUNK_SIZE = 500;
export const SEARCH_RENDER_LIMIT = 200;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Builds a deterministic catalog. `typeFor(i)` returns 'video' | 'article' |
 * 'short' for item i. Video ids are 11 chars so cards render as embeds;
 * shorts are videos with a /shorts/ url; articles carry a preview image.
 */
export function makeItems(n, typeFor = () => 'video') {
  const base = 1_700_000_000_000; // fixed epoch — no Date.now(), reproducible order
  return Array.from({ length: n }, (_, i) => {
    const type = typeFor(i);
    const id =
      type === 'article'
        ? `article_id_${String(i).padStart(6, '0')}`
        : `vid${String(i).padStart(8, '0')}`; // 11 chars -> video embed
    const url =
      type === 'article'
        ? `https://example.com/articles/${i}`
        : type === 'short'
          ? `https://www.youtube.com/shorts/${id}`
          : `https://www.youtube.com/watch?v=${id}`;
    const brand = ['Rolex', 'Omega', 'Tudor', 'Seiko', 'Grand Seiko'][i % 5];
    const item = {
      video_id: id,
      media_type: type === 'article' ? 'article' : 'video',
      channel_name: `Channel ${i % 12}`,
      title: `${brand} ${type} deep dive #${i}`,
      url,
      published_at: new Date(base - (i + 1) * 60000).toISOString(),
      category: 'Reviews',
      comment_count: i % 4,
      vote_count: 0,
    };
    if (type === 'article') item.preview_image = `https://example.com/img/${i}.jpg`;
    return item;
  });
}

/**
 * Installs the mocked Apps Script backend and returns a live `control`
 * object the test can read (which pages were requested) and mutate
 * (block/unblock, adjust latency) mid-flight.
 *
 * Options:
 *   items        catalog array (default 60 videos)
 *   topWeek      array for the Top tab (default: newest 50)
 *   feedDelay    ms latency on a NORMAL page fetch (limit <= PAGE_SIZE);
 *                number, or (page, limit) => ms for per-page control
 *   chunkDelay   ms latency on a SEARCH-INDEX chunk fetch (big limit)
 *   voteDelay    ms latency on a vote POST
 *   clearStorage wipe localStorage on every navigation (default true);
 *                pass false for warm-cache / revalidation tests
 */
export async function installMocks(page, opts = {}) {
  const {
    items = makeItems(60),
    topWeek = null,
    feedDelay = 0,
    chunkDelay = 0,
    voteDelay = 0,
    clearStorage = true,
  } = opts;

  const control = {
    requests: [], // every request: { action, page, limit }
    feedPages: [], // normal-limit feed page numbers
    chunkPages: [], // search-index chunk page numbers
    topRequests: 0,
    feedBlocked: false, // hang normal feed fetches
    chunkBlocked: false, // hang search-index chunk fetches
    feedDelay,
  };

  if (clearStorage) {
    await page.addInitScript(() => window.localStorage.clear());
  }

  // Embeds are a third-party dependency — a perf test must not measure
  // YouTube's servers. Serve an empty document for every embed navigation.
  await page.route('**://*.youtube-nocookie.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>embed</title>' })
  );

  const topList = topWeek || items.slice(0, 50);
  const delayFor = (pg, limit) =>
    typeof control.feedDelay === 'function' ? control.feedDelay(pg, limit) : control.feedDelay;

  await page.route('**/macros/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    let action = url.searchParams.get('action');
    let body = {};
    if (!action && req.method() === 'POST') {
      try {
        body = JSON.parse(req.postData() || '{}');
      } catch {
        /* noop */
      }
      action = body.action;
    }

    const json = (obj) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });

    if (action === 'feed') {
      const pg = parseInt(url.searchParams.get('page'), 10) || 1;
      const limit = parseInt(url.searchParams.get('limit'), 10) || PAGE_SIZE;
      const isChunk = limit > PAGE_SIZE;
      control.requests.push({ action, page: pg, limit });

      if (isChunk) {
        control.chunkPages.push(pg);
        if (chunkDelay) await sleep(chunkDelay);
        if (control.chunkBlocked) return; // leave hanging
      } else {
        control.feedPages.push(pg);
        const d = delayFor(pg, limit);
        if (d) await sleep(d);
        if (control.feedBlocked) return; // leave hanging
      }

      const start = (pg - 1) * limit;
      return json({ status: 'ok', total: items.length, page: pg, videos: items.slice(start, start + limit) });
    }

    if (action === 'topWeek') {
      control.topRequests++;
      return json({ status: 'ok', total: topList.length, videos: topList });
    }
    if (action === 'commentsBatch') return json({ status: 'ok', byVideo: {} });
    if (action === 'comments') return json({ status: 'ok', comments: [] });
    if (action === 'bootstrap') return json({ status: 'ok', video_ids: [], channels: [] });
    if (action === 'myStars') return json({ status: 'ok', channels: [] });
    if (action === 'myVotes') return json({ status: 'ok', video_ids: [] });
    if (action === 'vote') {
      if (voteDelay) await sleep(voteDelay);
      return json({ status: 'ok', voted: true, vote_count: (body.count || 0) + 1 });
    }
    return json({ status: 'ok', api_secret: 'test_secret' });
  });

  return control;
}

/** Seeds a fake signed-in Google session (mirrors starred_tab.spec.js). */
export async function signIn(page) {
  await page.addInitScript(() => {
    const payload = btoa(
      JSON.stringify({
        name: 'Perf User',
        email: 'perf@example.com',
        picture: '',
        exp: Math.floor(Date.now() / 1000) + 3600, // future expiry (browser clock)
      })
    );
    localStorage.setItem(
      'wd_user',
      JSON.stringify({ name: 'Perf User', email: 'perf@example.com', picture: '', token: `h.${payload}.s` })
    );
  });
}

/** Records long tasks (>50ms main-thread blocks) into window.__longTasks. */
export async function installLongTaskObserver(page) {
  await page.addInitScript(() => {
    window.__longTasks = [];
    try {
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__longTasks.push(Math.round(e.duration));
      });
      obs.observe({ entryTypes: ['longtask'] });
    } catch {
      /* longtask not supported */
    }
  });
}

export async function longTaskStats(page) {
  return page.evaluate(() => {
    const t = window.__longTasks || [];
    return { count: t.length, max: t.length ? Math.max(...t) : 0, total: t.reduce((a, b) => a + b, 0) };
  });
}

export async function resetLongTasks(page) {
  await page.evaluate(() => {
    window.__longTasks = [];
  });
}

/** FCP / LCP from the Performance timeline (ms since navigation start). */
export async function paintMetrics(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const out = { fcp: null, lcp: null };
        try {
          for (const e of performance.getEntriesByType('paint')) {
            if (e.name === 'first-contentful-paint') out.fcp = Math.round(e.startTime);
          }
          new PerformanceObserver((list) => {
            const entries = list.getEntries();
            out.lcp = Math.round(entries[entries.length - 1].startTime);
          }).observe({ type: 'largest-contentful-paint', buffered: true });
        } catch {
          /* unsupported */
        }
        setTimeout(() => resolve(out), 250);
      })
  );
}

/** All rendered card ids, in DOM order. */
export async function cardIds(page) {
  return page.locator('.media-card[data-video-id]').evaluateAll((cards) => cards.map((c) => c.dataset.videoId));
}

/** True if every id is unique. */
export function allUnique(ids) {
  return ids.length === new Set(ids).size;
}

/** Scrolls to the infinite-scroll sentinel to request the next page. */
export async function scrollToBottom(page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
}
