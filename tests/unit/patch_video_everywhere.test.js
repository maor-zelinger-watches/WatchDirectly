/**
 * Unit tests for the FE13/FE14 state helpers (fe-state-refactor).
 *
 * patchVideoEverywhere — one call updates a video's row in EVERY list that
 * holds a copy (feed, Top This Week, search index) and persists the feed once
 * through the coalesced cache write. It replaces the four hand-rolled
 * walk-every-list blocks that kept drifting apart (that drift is exactly how
 * search cards lost their counts).
 *
 * epoch — the single owner of the app's generation counters: claim() opens a
 * new generation (retiring older handles), observe() snapshots the current
 * one, bump() retires everything outstanding.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ saveFeedCacheSoon: vi.fn() }));
vi.mock('../../js/cache.js', () => ({ saveFeedCacheSoon: mocks.saveFeedCacheSoon }));

import { state, patchVideoEverywhere, epoch } from '../../js/state.js';

const row = (id) => ({ video_id: id, vote_count: 1, comment_count: 2 });

beforeEach(() => {
  mocks.saveFeedCacheSoon.mockReset();
  state.videos = [row('a'), row('b')];
  state.topVideos = [row('b'), row('a')];
  state.searchIndex = [row('a'), row('b'), row('c')];
  state.totalVideos = 42;
});

describe('patchVideoEverywhere (FE13)', () => {
  it('updates the row in all three lists', () => {
    patchVideoEverywhere('a', { vote_count: 9, comment_count: 5 });
    for (const list of [state.videos, state.topVideos, state.searchIndex]) {
      const v = list.find(x => x.video_id === 'a');
      expect(v.vote_count).toBe(9);
      expect(v.comment_count).toBe(5);
    }
  });

  it('leaves other rows untouched', () => {
    patchVideoEverywhere('a', { vote_count: 9 });
    expect(state.videos.find(x => x.video_id === 'b').vote_count).toBe(1);
    expect(state.searchIndex.find(x => x.video_id === 'c').vote_count).toBe(1);
  });

  it('persists the feed exactly once, via the coalesced write', () => {
    patchVideoEverywhere('a', { vote_count: 9 });
    expect(mocks.saveFeedCacheSoon).toHaveBeenCalledTimes(1);
    expect(mocks.saveFeedCacheSoon).toHaveBeenCalledWith(state.videos, 42);
  });

  it('skips lists that are not loaded (null) without throwing', () => {
    state.topVideos = null;
    state.searchIndex = null;
    expect(patchVideoEverywhere('a', { vote_count: 7 })).toBe(true);
    expect(state.videos.find(x => x.video_id === 'a').vote_count).toBe(7);
  });

  it('does not persist the feed when only a non-feed list holds the row', () => {
    // 'c' lives only in the search index — patched there, no feed write.
    expect(patchVideoEverywhere('c', { vote_count: 7 })).toBe(false);
    expect(state.searchIndex.find(x => x.video_id === 'c').vote_count).toBe(7);
    expect(mocks.saveFeedCacheSoon).not.toHaveBeenCalled();
  });
});

describe('epoch (FE14)', () => {
  it('a newer claim retires the older handle', () => {
    const first = epoch.claim('t_claim');
    expect(first.current()).toBe(true);
    const second = epoch.claim('t_claim');
    expect(first.current()).toBe(false);
    expect(second.current()).toBe(true);
  });

  it('bump retires an outstanding claim without claiming one itself', () => {
    const e = epoch.claim('t_bump');
    epoch.bump('t_bump');
    expect(e.current()).toBe(false);
  });

  it('observe snapshots the current generation and detects a later bump', () => {
    const e = epoch.observe('t_observe');
    expect(e.current()).toBe(true);
    epoch.bump('t_observe');
    expect(e.current()).toBe(false);
  });

  it('names are independent counters', () => {
    const a = epoch.claim('t_indep_a');
    epoch.bump('t_indep_b');
    expect(a.current()).toBe(true);
  });
});
