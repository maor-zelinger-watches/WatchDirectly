/**
 * app.js — Main application controller for WatchDirectly
 * 
 * Single-page feed with inline comments. No routing.
 */

import { createApiClient } from './api.js';
import { createVideoCard, sortVideos } from './feed.js';
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
  currentPage: 1,
  totalVideos: 0,
  loading: false,
  expandedComments: new Set(), // Track which video cards have comments open
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

  setupLoadMore();

  // Load feed
  loadFeed();
});

// ============================================================
// FEED
// ============================================================

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

  // Sort chronologically
  const videos = sortVideos(state.videos);

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

  // Attach comment toggle handlers
  attachCommentToggleHandlers();
}

// ============================================================
// INLINE COMMENTS
// ============================================================

function attachCommentToggleHandlers() {
  document.querySelectorAll('.video-card__comments-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const videoId = btn.dataset.videoId;
      toggleComments(videoId);
    });
  });
}

function toggleComments(videoId) {
  const body = document.querySelector(`.video-card__comments-body[data-video-id="${videoId}"]`);
  if (!body) return;

  const isExpanded = body.style.display !== 'none';

  if (isExpanded) {
    body.style.display = 'none';
    state.expandedComments.delete(videoId);
  } else {
    body.style.display = '';
    state.expandedComments.add(videoId);
    loadInlineComments(videoId);
    updateInlineCommentFormUI(videoId);
    setupInlineCommentForm(videoId);
  }
}

async function loadInlineComments(videoId) {
  const listEl = document.querySelector(`.video-card__comments-list[data-video-id="${videoId}"]`);
  if (!listEl) return;

  listEl.innerHTML = '<div class="comments-loading-inline"><div class="spinner"></div></div>';

  try {
    const data = await api.fetchComments(videoId);
    const comments = data.comments || [];
    const tree = buildCommentTree(comments);

    // Update toggle button count
    const toggleBtn = document.querySelector(`.video-card__comments-toggle[data-video-id="${videoId}"]`);
    if (toggleBtn) {
      toggleBtn.textContent = `💬 ${comments.length} comments`;
    }

    if (tree.length === 0) {
      listEl.innerHTML = '<p class="comments-empty">No comments yet. Be the first!</p>';
    } else {
      listEl.innerHTML = tree.map(c => createCommentThread(c)).join('');
      attachReplyHandlers(videoId);
    }
  } catch (error) {
    console.error('Failed to load comments:', error);
    listEl.innerHTML = '<p class="comments-empty">Failed to load comments.</p>';
  }
}

function updateInlineCommentFormUI(videoId) {
  const authPrompt = document.querySelector(`.video-card__auth-prompt[data-video-id="${videoId}"]`);
  const form = document.querySelector(`.video-card__comment-form[data-video-id="${videoId}"]`);
  if (!authPrompt || !form) return;

  const user = getCurrentUser();
  if (user) {
    authPrompt.style.display = 'none';
    form.style.display = '';
  } else {
    authPrompt.style.display = '';
    form.style.display = 'none';
  }
}

function setupInlineCommentForm(videoId) {
  const form = document.querySelector(`.video-card__comment-form[data-video-id="${videoId}"]`);
  const textarea = document.querySelector(`.video-card__textarea[data-video-id="${videoId}"]`);
  if (!form || !textarea || form.dataset.bound) return;

  form.dataset.bound = 'true';

  const charcount = form.querySelector('.video-card__charcount');
  textarea.addEventListener('input', () => {
    if (charcount) charcount.textContent = `${textarea.value.length}/2000`;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await submitInlineComment(videoId, '', textarea);
  });
}

async function submitInlineComment(videoId, parentId, textarea) {
  const body = textarea.value.trim();
  if (!body) return;

  if (!isSignedIn()) {
    showToast('Please sign in to comment', 'info');
    return;
  }

  const submitBtn = textarea.closest('form').querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  try {
    await api.postComment(videoId, parentId, body, getToken());
    textarea.value = '';
    showToast('Comment posted!', 'success');
    loadInlineComments(videoId);
  } catch (error) {
    console.error('Failed to post comment:', error);
    showToast(error.message || 'Failed to post comment', 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function attachReplyHandlers(videoId) {
  const card = document.querySelector(`.video-card[data-video-id="${videoId}"]`);
  if (!card) return;

  card.querySelectorAll('.reply-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const commentId = e.currentTarget.dataset.commentId;
      toggleReplyForm(videoId, commentId);
    });
  });
}

function toggleReplyForm(videoId, commentId) {
  // Remove any existing reply forms in this card
  const card = document.querySelector(`.video-card[data-video-id="${videoId}"]`);
  if (card) card.querySelectorAll('.reply-form').forEach(f => f.remove());

  if (!isSignedIn()) {
    showToast('Please sign in to reply', 'info');
    return;
  }

  const commentEl = card.querySelector(`.comment[data-comment-id="${commentId}"]`);
  if (!commentEl) return;

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
    submitInlineComment(videoId, commentId, textarea);
  });
}

// ============================================================
// AUTH UI
// ============================================================

function setupAuthUI() {
  const container = document.getElementById('auth-container');

  onAuthChange((user) => {
    updateAuthUI(user);
    // Update all expanded comment forms when auth state changes
    state.expandedComments.forEach(videoId => {
      updateInlineCommentFormUI(videoId);
    });
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

// ============================================================
// LOAD MORE
// ============================================================

function setupLoadMore() {
  document.getElementById('load-more-btn').addEventListener('click', () => {
    loadFeed(state.currentPage + 1);
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
