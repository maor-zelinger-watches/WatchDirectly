/**
 * bootstrap.js — one-round-trip sign-in reconciliation.
 *
 * On sign-in the client needs two things about the user: which videos they've
 * upvoted and which creators they've starred. Fetched separately those were two
 * POSTs that — because Apps Script serializes a user's requests — queued
 * nose-to-tail at boot, and each re-verified the ID token over the network.
 *
 * loadMyVotesAndStars fires the single batched `bootstrap` request and hands the
 * SAME promise to both reconcilers. Each still captures its own epoch before
 * awaiting, so a vote or star toggled while the request is in flight wins — the
 * batching changes the transport, not the race semantics.
 */

import { api } from './api-client.js';
import { isSignedIn, getToken, isTokenExpired, refreshToken } from './auth.js';
import { reconcileMyVotes } from './votes.js';
import { reconcileMyStars } from './stars.js';

export async function loadMyVotesAndStars() {
  if (!isSignedIn()) return;
  let token = getToken();
  if (isTokenExpired()) token = await refreshToken();
  if (!token) return; // can't reconcile right now; caches stay best-effort

  const pending = api.fetchBootstrap(token);
  await Promise.all([reconcileMyVotes(pending), reconcileMyStars(pending)]);
}
