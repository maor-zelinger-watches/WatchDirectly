/**
 * bootstrap.js — one-round-trip sign-in reconciliation.
 *
 * On sign-in the client needs three things about the user: which videos
 * they've upvoted, which creators they've starred, and which items they've
 * bookmarked. Fetched separately those were POSTs that — because Apps Script
 * serializes a user's requests — queued nose-to-tail at boot, and each
 * re-verified the ID token over the network.
 *
 * loadMyVotesAndStars fires the single batched `bootstrap` request and hands
 * the SAME promise to every reconciler. Each still captures its own epoch
 * before awaiting, so a vote, star, or bookmark toggled while the request is
 * in flight wins — the batching changes the transport, not the race semantics.
 */

/*
 * Clickjacking frame-buster. This JS is the ONLY working protection: the CSP
 * in index.html ships via <meta http-equiv>, and the spec says frame-ancestors
 * is IGNORED when delivered that way — and GitHub Pages can't send real HTTP
 * headers (X-Frame-Options / frame-ancestors). Without this, an attacker can
 * frame the site invisibly over decoy UI and a returning visitor's restored
 * localStorage session makes their clicks land on vote/star/comment controls.
 * Do not "simplify" this away. If the site ever moves behind a host that can
 * send headers, add X-Frame-Options: DENY / frame-ancestors 'none' there and
 * keep this as defense-in-depth.
 */
if (self !== top) {
  document.documentElement.style.display = 'none';
  try { top.location = self.location; } catch (e) {}
}

import { api } from './api-client.js';
import { isSignedIn, getToken, isTokenExpired, refreshToken } from './auth.js';
import { reconcileMyVotes } from './votes.js';
import { reconcileMyStars } from './stars.js';
import { reconcileMyBookmarks } from './bookmarks.js';

export async function loadMyVotesAndStars() {
  if (!isSignedIn()) return;
  let token = getToken();
  if (isTokenExpired()) token = await refreshToken();
  if (!token) return; // can't reconcile right now; caches stay best-effort

  const pending = api.fetchBootstrap(token);
  await Promise.all([
    reconcileMyVotes(pending),
    reconcileMyStars(pending),
    reconcileMyBookmarks(pending),
  ]);
}
