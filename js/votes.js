/**
 * votes.js — Upvotes: optimistic toggling and sign-in reconciliation.
 *
 * The server is the source of truth for counts; the UI flips instantly
 * and rolls back on failure. voteEpoch orders local mutations against
 * the fetchMyVotes snapshot so a slow fetch can't clobber a vote the
 * user just cast.
 */

import { state } from './state.js';
import { api } from './api-client.js';
import { isSignedIn, getToken, isTokenExpired, refreshToken, ensureToken } from './auth.js';
import { saveFeedCache } from './cache.js';
import { showToast } from './toast.js';

// Bumped on every local vote mutation so a slow fetchMyVotes snapshot
// can't clobber a vote the user just cast.
let voteEpoch = 0;

/** Updates every vote button for a video (both views may have one rendered). */
function setVoteButtons(videoId, voted, count) {
  document.querySelectorAll(`.media-card__vote[data-video-id="${videoId}"]`).forEach(btn => {
    btn.classList.toggle('media-card__vote--active', voted);
    btn.setAttribute('aria-pressed', voted ? 'true' : 'false');
    if (count != null) {
      const countEl = btn.querySelector('.media-card__vote-count');
      if (countEl) countEl.textContent = String(count);
    }
  });
}

/** Keeps vote counts in cached state + localStorage in sync after a vote. */
function updateCachedVoteCount(videoId, count) {
  const v = state.videos.find(x => x.video_id === videoId);
  if (v) {
    v.vote_count = count;
    saveFeedCache(state.videos, state.totalVideos);
  }
  if (state.topVideos) {
    const tv = state.topVideos.find(x => x.video_id === videoId);
    if (tv) tv.vote_count = count;
  }
}

/**
 * Toggles the current user's upvote on a video, optimistically.
 * The server is the source of truth for the final count.
 */
export async function toggleVote(videoId) {
  if (!isSignedIn()) {
    showToast('Please sign in to vote', 'info');
    return;
  }

  const wasVoted = state.myVotes.has(videoId);
  const sample = document.querySelector(`.media-card__vote[data-video-id="${videoId}"] .media-card__vote-count`);
  const prevCount = sample ? (parseInt(sample.textContent, 10) || 0) : 0;
  const optimisticCount = Math.max(0, prevCount + (wasVoted ? -1 : 1));

  // Optimistic flip
  voteEpoch++;
  if (wasVoted) state.myVotes.delete(videoId); else state.myVotes.add(videoId);
  setVoteButtons(videoId, !wasVoted, optimisticCount);

  try {
    const token = await ensureToken();
    const res = await api.vote(videoId, token);

    // Reconcile with server truth
    voteEpoch++;
    if (res.voted) state.myVotes.add(videoId); else state.myVotes.delete(videoId);
    setVoteButtons(videoId, res.voted, res.vote_count);
    updateCachedVoteCount(videoId, res.vote_count);
  } catch (error) {
    console.error('Failed to vote:', error);
    // Rollback — unless the failure signed the user out, in which case
    // clearVoteMarkings already put the UI in the right state.
    if (isSignedIn()) {
      voteEpoch++;
      if (wasVoted) state.myVotes.add(videoId); else state.myVotes.delete(videoId);
      // Undo exactly our optimistic delta from whatever count is displayed
      // NOW — a concurrent update may have replaced prevCount already.
      const countEl = document.querySelector(`.media-card__vote[data-video-id="${videoId}"] .media-card__vote-count`);
      const shownCount = countEl ? (parseInt(countEl.textContent, 10) || 0) : optimisticCount;
      setVoteButtons(videoId, wasVoted, Math.max(0, shownCount - (wasVoted ? -1 : 1)));
    }
    showToast(error.message || 'Failed to vote. Please try again.', 'error');
  }
}

/**
 * Loads the signed-in user's upvotes and marks their buttons.
 * Called on sign-in so the UI reflects past votes.
 */
export async function loadMyVotes() {
  if (!isSignedIn()) return;
  try {
    let token = getToken();
    if (isTokenExpired()) token = await refreshToken();
    if (!token) return; // can't reconcile right now

    const epoch = voteEpoch;
    const data = await api.fetchMyVotes(token);
    // A vote cast while this was in flight beats the older snapshot
    if (epoch !== voteEpoch) return;

    state.myVotes = new Set(data.video_ids || []);
    document.querySelectorAll('.media-card__vote').forEach(btn => {
      const voted = state.myVotes.has(btn.dataset.videoId);
      btn.classList.toggle('media-card__vote--active', voted);
      btn.setAttribute('aria-pressed', voted ? 'true' : 'false');
    });
  } catch (e) {
    /* silent — voting still works, buttons just won't show prior state */
  }
}

/** Clears all vote markings (on sign-out). */
export function clearVoteMarkings() {
  state.myVotes.clear();
  document.querySelectorAll('.media-card__vote--active').forEach(btn => {
    btn.classList.remove('media-card__vote--active');
    btn.setAttribute('aria-pressed', 'false');
  });
}
