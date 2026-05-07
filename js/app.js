/**
 * app.js — Main application controller for WatchDirectly
 * 
 * Initializes all modules, handles routing, and manages view state.
 * Hash-based routing: #/ (feed) and #/post/VIDEO_ID (detail).
 */

import { createApiClient } from './api.js';
import { createVideoCard, sortVideos, filterVideos } from './feed.js';
import { buildCommentTree, createCommentThread, createCommentHtml, validateCommentDepth } from './comments.js';
import { initAuth, renderSignInButton, getCurrentUser, isSignedIn, getToken, onAuthChange, signOut } from './auth.js';
import { timeAgo, formatDate, sanitizeHtml, generateId } from './utils.js';

// ============================================================
// CONFIGURATION — Update these after setup
// ============================================================

const CONFIG = {
  // Replace with your deployed Google Apps Script URL
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwyt7c8SWw9y0TnKq4RhcV7yLjS1JkXnNThYInpj-EnNYbA3ecgwVSX4gBIACNKHCqu0A/exec',
  // Replace with your Google OAuth Client ID
  GOOGLE_CLIENT_ID: '58088759188-uhqgajeoe8h218h3o6pql634pkcjsu70.apps.googleusercontent.com',
  // Videos per page
  PAGE_SIZE: 20,
};

// ============================================================
// STATE
// ============================================================

const state = {
  videos: [],
  currentFilter: 'all',
  currentPage: 1,
  totalVideos: 0,
  currentVideoId: null,
  loading: false,
};

const api = createApiClient(CONFIG.APPS_SCRIPT_URL);

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  // GSI SDK loads async — retry until it's available
  function tryInitAuth() {
    if (typeof google !== 'undefined' && google.accounts) {
      initAuth(CONFIG.GOOGLE_CLIENT_ID);
      setupAuthUI();
    } else {
      setTimeout(tryInitAuth, 200);
    }
  }
  tryInitAuth();

  setupFilterTabs();
  setupLoadMore();
  setupCommentForm();
  setupBackButton();

  // Handle initial route
  handleRoute();

  // Listen for hash changes
  window.addEventListener('hashchange', handleRoute);
});

// ============================================================
// ROUTING
// ============================================================

function handleRoute() {
  const hash = window.location.hash || '#/';

  if (hash.startsWith('#/post/')) {
    const videoId = hash.replace('#/post/', '');
    showDetailView(videoId);
  } else {
    showFeedView();
  }
}

function navigate(hash) {
  window.location.hash = hash;
}

// ============================================================
// FEED VIEW
// ============================================================

function showFeedView() {
  document.getElementById('feed-view').style.display = '';
  document.getElementById('detail-view').style.display = 'none';
  document.getElementById('back-btn').style.display = 'none';

  state.currentVideoId = null;

  // Only load if we don't have videos yet
  if (state.videos.length === 0) {
    loadFeed();
  }
}

async function loadFeed(page = 1) {
  if (state.loading) return;
  state.loading = true;

  const feedContainer = document.getElementById('feed-container');
  const skeleton = document.getElementById('feed-skeleton');
  const loadMore = document.getElementById('load-more-container');
  const empty = document.getElementById('feed-empty');

  // Show skeleton on first load
  if (page === 1) {
    feedContainer.innerHTML = '';
    skeleton.style.display = '';
    loadMore.style.display = 'none';
    empty.style.display = 'none';
  }

  try {
    const data = await api.fetchFeed(page, CONFIG.PAGE_SIZE);

    if (page === 1) {
      state.videos = data.videos || [];
    } else {
      state.videos = state.videos.concat(data.videos || []);
    }

    state.totalVideos = data.total || 0;
    state.currentPage = page;

    renderFeed();
  } catch (error) {
    console.error('Failed to load feed:', error);
    showToast('Failed to load feed. Please try again.', 'error');
  } finally {
    state.loading = false;
    skeleton.style.display = 'none';
  }
}

function renderFeed() {
  const feedContainer = document.getElementById('feed-container');
  const loadMore = document.getElementById('load-more-container');
  const empty = document.getElementById('feed-empty');

  let videos = state.videos;

  // Apply filter
  if (state.currentFilter !== 'all') {
    videos = filterVideos(videos, parseInt(state.currentFilter));
  }

  // Sort chronologically
  videos = sortVideos(videos);

  if (videos.length === 0) {
    feedContainer.innerHTML = '';
    empty.style.display = '';
    loadMore.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  feedContainer.innerHTML = videos.map(v => createVideoCard(v)).join('');

  // Show/hide load more
  const hasMore = state.videos.length < state.totalVideos;
  loadMore.style.display = hasMore ? '' : 'none';

  // Attach click handlers to entire video card (except iframe)
  feedContainer.querySelectorAll('.video-card').forEach(card => {
    card.addEventListener('click', (e) => {
      // Don't navigate if clicking on the iframe itself
      if (e.target.tagName === 'IFRAME') return;
      const videoId = card.dataset.videoId;
      navigate(`#/post/${videoId}`);
    });
    card.style.cursor = 'pointer';
  });
}

// ============================================================
// DETAIL VIEW
// ============================================================

async function showDetailView(videoId) {
  document.getElementById('feed-view').style.display = 'none';
  document.getElementById('detail-view').style.display = '';
  document.getElementById('back-btn').style.display = '';

  state.currentVideoId = videoId;

  // Find video in state or use minimal data
  const video = state.videos.find(v => v.video_id === videoId) || { video_id: videoId };

  renderDetailVideo(video);
  loadComments(videoId);
}

function renderDetailVideo(video) {
  const container = document.getElementById('detail-video');
  const title = sanitizeHtml(video.title || 'Loading...');
  const channel = sanitizeHtml(video.channel_name || '');

  container.innerHTML = `
    <div class="detail-view__embed">
      <iframe
        src="https://www.youtube-nocookie.com/embed/${video.video_id}?autoplay=0"
        title="${title}"
        frameborder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen
      ></iframe>
    </div>
    <div class="detail-view__info">
      <h2 class="detail-view__title">${title}</h2>
      <div class="detail-view__meta">
        <span>🎬 ${channel}</span>
        ${video.published_at ? `<span>·</span><span>${formatDate(video.published_at)} · ${timeAgo(video.published_at)}</span>` : ''}
      </div>
      ${video.tier !== undefined ? `
        <div class="detail-view__tags">
          <span class="video-card__tier tier-${video.tier}">Tier ${video.tier}</span>
          <span class="video-card__separator">·</span>
          <span class="video-card__category">${sanitizeHtml(video.category || '')}</span>
        </div>
      ` : ''}
    </div>
  `;
}

async function loadComments(videoId) {
  const commentsList = document.getElementById('comments-list');
  const commentsLoading = document.getElementById('comments-loading');
  const commentsHeader = document.getElementById('comments-header');

  commentsList.innerHTML = '';
  commentsLoading.style.display = '';

  try {
    const data = await api.fetchComments(videoId);
    const comments = data.comments || [];
    const tree = buildCommentTree(comments);

    commentsHeader.textContent = `💬 Comments (${comments.length})`;

    if (tree.length === 0) {
      commentsList.innerHTML = '<p class="comments-empty" style="text-align: center; color: var(--text-muted); padding: 24px;">No comments yet. Be the first!</p>';
    } else {
      commentsList.innerHTML = tree.map(c => createCommentThread(c)).join('');
      attachReplyHandlers();
    }
  } catch (error) {
    console.error('Failed to load comments:', error);
    commentsList.innerHTML = '<p style="text-align: center; color: var(--text-muted);">Failed to load comments.</p>';
  } finally {
    commentsLoading.style.display = 'none';
  }
}

// ============================================================
// COMMENT POSTING
// ============================================================

function setupCommentForm() {
  const form = document.getElementById('comment-form');
  const textarea = document.getElementById('comment-textarea');
  const charcount = document.getElementById('comment-charcount');

  textarea.addEventListener('input', () => {
    charcount.textContent = `${textarea.value.length}/2000`;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await submitComment('', textarea);
  });
}

async function submitComment(parentId, textarea) {
  const body = textarea.value.trim();
  if (!body) return;

  if (!isSignedIn()) {
    showToast('Please sign in to comment', 'info');
    return;
  }

  const submitBtn = textarea.closest('form').querySelector('button[type="submit"], .reply-submit-btn');
  if (submitBtn) submitBtn.disabled = true;

  try {
    await api.postComment(state.currentVideoId, parentId, body, getToken());
    textarea.value = '';
    showToast('Comment posted!', 'success');
    // Reload comments
    loadComments(state.currentVideoId);
  } catch (error) {
    console.error('Failed to post comment:', error);
    showToast(error.message || 'Failed to post comment', 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function attachReplyHandlers() {
  document.querySelectorAll('.reply-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const commentId = e.currentTarget.dataset.commentId;
      toggleReplyForm(commentId);
    });
  });
}

function toggleReplyForm(commentId) {
  // Remove any existing reply forms
  document.querySelectorAll('.reply-form').forEach(f => f.remove());

  if (!isSignedIn()) {
    showToast('Please sign in to reply', 'info');
    return;
  }

  const commentEl = document.querySelector(`.comment[data-comment-id="${commentId}"]`);
  if (!commentEl) return;

  const user = getCurrentUser();
  const replyForm = document.createElement('div');
  replyForm.className = 'reply-form';
  replyForm.innerHTML = `
    <textarea class="reply-form__textarea" placeholder="Write a reply..." maxlength="2000" rows="2"></textarea>
    <div class="reply-form__actions">
      <button class="btn btn--ghost btn--sm reply-cancel-btn">Cancel</button>
      <button class="btn btn--primary btn--sm reply-submit-btn">Reply</button>
    </div>
  `;

  commentEl.parentNode.insertBefore(replyForm, commentEl.nextSibling);

  const textarea = replyForm.querySelector('textarea');
  textarea.focus();

  replyForm.querySelector('.reply-cancel-btn').addEventListener('click', () => {
    replyForm.remove();
  });

  replyForm.querySelector('.reply-submit-btn').addEventListener('click', () => {
    submitComment(commentId, textarea);
  });
}

// ============================================================
// AUTH UI
// ============================================================

function setupAuthUI() {
  const container = document.getElementById('auth-container');

  onAuthChange((user) => {
    updateAuthUI(user);
    updateCommentFormUI(user);
  });

  // Render sign-in button initially
  renderSignInButton(container);
}

function updateAuthUI(user) {
  const container = document.getElementById('auth-container');

  if (user) {
    container.innerHTML = `
      <div class="header__user">
        <img src="${user.picture}" alt="${sanitizeHtml(user.name)}" class="header__user-avatar" referrerpolicy="no-referrer" />
        <span class="header__user-name">${sanitizeHtml(user.name)}</span>
        <button class="header__signout-btn" id="signout-btn">Sign out</button>
      </div>
    `;
    document.getElementById('signout-btn').addEventListener('click', () => {
      signOut();
    });
  } else {
    container.innerHTML = '';
    renderSignInButton(container);
  }
}

function updateCommentFormUI(user) {
  const authPrompt = document.getElementById('comment-auth-prompt');
  const form = document.getElementById('comment-form');
  const userInfo = document.getElementById('comment-user-info');

  if (!authPrompt || !form) return;

  if (user) {
    authPrompt.style.display = 'none';
    form.style.display = '';
    userInfo.innerHTML = `
      <img src="${user.picture}" alt="${sanitizeHtml(user.name)}" referrerpolicy="no-referrer" />
      <span>${sanitizeHtml(user.name)}</span>
    `;
  } else {
    authPrompt.style.display = '';
    form.style.display = 'none';
  }
}

// ============================================================
// FILTER TABS
// ============================================================

function setupFilterTabs() {
  document.getElementById('filter-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-tabs__btn');
    if (!btn) return;

    // Update active state
    document.querySelectorAll('.filter-tabs__btn').forEach(b => b.classList.remove('filter-tabs__btn--active'));
    btn.classList.add('filter-tabs__btn--active');

    state.currentFilter = btn.dataset.filter;
    renderFeed();
  });
}

// ============================================================
// LOAD MORE
// ============================================================

function setupLoadMore() {
  document.getElementById('load-more-btn').addEventListener('click', () => {
    loadFeed(state.currentPage + 1);
  });
}

// ============================================================
// BACK BUTTON
// ============================================================

function setupBackButton() {
  document.getElementById('back-btn').addEventListener('click', () => {
    navigate('#/');
  });
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3000);
}
