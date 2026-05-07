/**
 * app.js — Main application controller for WatchDirectly
 * 
 * Single-page feed with inline comments.
 * Infinite scroll: loads one page at a time as user scrolls down.
 */

import { createApiClient } from './api.js';
import { createVideoCard, sortVideos } from './feed.js';
import { buildCommentTree, createCommentThread, createCommentHtml } from './comments.js';
import { initAuth, renderSignInButton, getCurrentUser, isSignedIn, getToken, onAuthChange, signOut } from './auth.js';
import { sanitizeHtml } from './utils.js';

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwyt7c8SWw9y0TnKq4RhcV7yLjS1JkXnNThYInpj-EnNYbA3ecgwVSX4gBIACNKHCqu0A/exec',
  GOOGLE_CLIENT_ID: '58088759188-uhqgajeoe8h218h3o6pql634pkcjsu70.apps.googleusercontent.com',
  PAGE_SIZE: 10,
};

// ============================================================
// STATE
// ============================================================

const state = {
  videos: [],          // All loaded videos so far
  currentPage: 0,      // Last page that was loaded
  totalVideos: 0,      // Total available from API
  loading: false,      // Prevents concurrent fetches
  hasMore: true,       // Whether more pages exist
  expandedComments: new Set(),
  initialLoadComplete: false,
};

const api = createApiClient(CONFIG.APPS_SCRIPT_URL);

// ============================================================
// SINGLE SHARED IFRAME OBSERVER
// Iframes only load their src when scrolled into view.
// ============================================================

const iframeObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const iframe = entry.target;
      if (iframe.dataset.src) {
        iframe.src = iframe.dataset.src;
        delete iframe.dataset.src;
      }
      iframeObserver.unobserve(iframe);
    }
  });
}, { rootMargin: '150px' });

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  let authRetries = 0;
  function tryInitAuth() {
    if (typeof google !== 'undefined' && google.accounts) {
      initAuth(CONFIG.GOOGLE_CLIENT_ID);
      setupAuthUI();
    } else if (authRetries++ < 50) {
      setTimeout(tryInitAuth, 200);
    }
  }
  tryInitAuth();

  setupInfiniteScroll();

  if (!showCachedFeed()) {
    loadNextPage();
  } else {
    // Stale-while-revalidate: patch comment counts from fresh API data
    revalidateCommentCounts();
  }
});

// ============================================================
// FEED — Dynamic initial load, then pagination
// ============================================================

async function loadNextPage() {
  if (state.loading || !state.hasMore) return;
  state.loading = true;

  const skeleton = document.getElementById('feed-skeleton');
  const empty = document.getElementById('feed-empty');
  const sentinel = document.getElementById('load-more-container');

  if (state.currentPage === 0 && !state.initialLoadComplete) {
    skeleton.style.display = '';
    empty.style.display = 'none';
  }

  sentinel.style.display = '';

  try {
    if (!state.initialLoadComplete) {
      // Calculate how many items fill the screen (N + 1)
      const cardHeight = window.innerWidth <= 540 ? 320 : 190;
      const N = Math.ceil(window.innerHeight / cardHeight);
      const initialLimit = Math.min(N + 1, CONFIG.PAGE_SIZE);

      // 1. Fetch N+1 items to show something immediately
      const data = await api.fetchFeed(1, initialLimit);
      const newVideos = data.videos || [];
      state.totalVideos = data.total || 0;
      state.videos = state.videos.concat(newVideos);
      
      skeleton.style.display = 'none';
      await appendCards(newVideos);
      state.initialLoadComplete = true;

      // 2. Fetch the remainder of the first page (up to PAGE_SIZE)
      if (initialLimit < CONFIG.PAGE_SIZE && state.videos.length < state.totalVideos) {
        const fullPageData = await api.fetchFeed(1, CONFIG.PAGE_SIZE);
        const fullVideos = fullPageData.videos || [];
        const remainingVideos = fullVideos.slice(initialLimit);
        
        state.videos = state.videos.concat(remainingVideos);
        await appendCards(remainingVideos);
      }

      state.currentPage = 1;
      state.hasMore = state.videos.length < state.totalVideos;
      localStorage.setItem('wd_feed_cache', JSON.stringify({ videos: state.videos, total: state.totalVideos }));

      if (state.videos.length === 0) {
        empty.style.display = '';
      }

    } else {
      // Normal infinite scroll for page 2 onwards
      const nextPage = state.currentPage + 1;
      const data = await api.fetchFeed(nextPage, CONFIG.PAGE_SIZE);
      const newVideos = data.videos || [];

      state.totalVideos = data.total || 0;
      state.currentPage = nextPage;
      state.videos = state.videos.concat(newVideos);
      state.hasMore = state.videos.length < state.totalVideos;

      await appendCards(newVideos);
    }
  } catch (error) {
    console.error('Failed to load feed:', error);
    if (state.videos.length === 0) {
      showToast('Failed to load feed. Please try again.', 'error');
    }
  } finally {
    state.loading = false;
    skeleton.style.display = 'none';
    
    if (!state.hasMore) {
      sentinel.style.display = 'none';
    } else {
      sentinel.style.display = '';
      // If the sentinel is still within the root margin after loading, 
      // trigger the next load manually. The IntersectionObserver won't re-fire
      // if it never exited the threshold while state.loading was true.
      requestAnimationFrame(() => {
        const rect = sentinel.getBoundingClientRect();
        if (rect.top > 0 && rect.top <= window.innerHeight + 600) {
          loadNextPage();
        }
      });
    }
  }
}

/**
 * Append video cards one at a time with staggered timing.
 * Returns a Promise that resolves when all cards have been appended.
 */
function appendCards(videos) {
  return new Promise((resolve) => {
    if (videos.length === 0) {
      resolve();
      return;
    }

    const feedContainer = document.getElementById('feed-container');
    const sorted = sortVideos(videos);

    sorted.forEach((video, i) => {
      setTimeout(() => {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = createVideoCard(video);
        const card = wrapper.firstElementChild;
        card.classList.add('video-card--entering');
        feedContainer.appendChild(card);

        requestAnimationFrame(() => {
          card.classList.remove('video-card--entering');
        });

        const toggle = card.querySelector('.video-card__comments-toggle');
        if (toggle) {
          toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleComments(toggle.dataset.videoId);
          });
        }

        const iframe = card.querySelector('iframe[data-src]');
        if (iframe) {
          iframeObserver.observe(iframe);
        }

        // Resolve when the last card is appended
        if (i === sorted.length - 1) {
          setTimeout(resolve, 50);
        }
      }, i * 60);
    });
  });
}

/**
 * Show cached feed instantly on page load (stale-while-revalidate).
 * Called before loadNextPage so the user sees content immediately.
 */
function showCachedFeed() {
  const cached = localStorage.getItem('wd_feed_cache');
  if (!cached) return false;

  try {
    const data = JSON.parse(cached);
    const videos = data.videos || [];
    
    // Cache must have a valid total to support pagination math
    if (videos.length === 0 || typeof data.total !== 'number' || data.total === 0) {
      localStorage.removeItem('wd_feed_cache');
      return false;
    }

    state.videos = videos;
    state.totalVideos = data.total;
    state.currentPage = 1;
    state.hasMore = state.videos.length < state.totalVideos;
    state.initialLoadComplete = true;

    // Make sentinel visible so the IntersectionObserver can fire for page 2
    if (state.hasMore) {
      const sentinel = document.getElementById('load-more-container');
      if (sentinel) sentinel.style.display = '';
    }

    appendCards(videos);
    return true;
  } catch (e) {
    localStorage.removeItem('wd_feed_cache');
    return false;
  }
}

/**
 * Background revalidation: fetch fresh feed data and patch comment counts
 * in the DOM without re-rendering the entire feed.
 */
async function revalidateCommentCounts() {
  try {
    const data = await api.fetchFeed(1, CONFIG.PAGE_SIZE);
    const freshVideos = data.videos || [];

    for (const video of freshVideos) {
      const toggle = document.querySelector(`.video-card__comments-toggle[data-video-id="${video.video_id}"]`);
      if (toggle) {
        const currentCount = parseInt(toggle.textContent.replace(/[^0-9]/g, '')) || 0;
        const freshCount = video.comment_count || 0;
        if (freshCount !== currentCount) {
          toggle.textContent = `💬 ${freshCount} comments`;
        }
      }
    }

    // Update cached state so next page load also has fresh counts
    const cachedVideos = state.videos.map(v => {
      const fresh = freshVideos.find(fv => fv.video_id === v.video_id);
      return fresh ? { ...v, comment_count: fresh.comment_count } : v;
    });
    state.videos = cachedVideos;
    localStorage.setItem('wd_feed_cache', JSON.stringify({ videos: cachedVideos, total: state.totalVideos }));
  } catch (e) {
    // Silent fail — stale counts are acceptable
  }
}

/**
 * Update comment_count in both state.videos and localStorage cache
 * after a successful comment post. Prevents stale-count flash on next load.
 */
function updateCachedCommentCount(videoId, newCount) {
  const video = state.videos.find(v => v.video_id === videoId);
  if (video) {
    video.comment_count = newCount;
    localStorage.setItem('wd_feed_cache', JSON.stringify({ videos: state.videos, total: state.totalVideos }));
  }
}

// ============================================================
// INFINITE SCROLL
// ============================================================

function setupInfiniteScroll() {
  const sentinel = document.getElementById('load-more-container');

  const scrollObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting && !state.loading && state.hasMore) {
        loadNextPage();
      }
    });
  }, { rootMargin: '600px' });

  scrollObserver.observe(sentinel);
}

// ============================================================
// INLINE COMMENTS
// ============================================================

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

    const toggleBtn = document.querySelector(`.video-card__comments-toggle[data-video-id="${videoId}"]`);
    if (toggleBtn) toggleBtn.textContent = `💬 ${comments.length} comments`;

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

  if (getCurrentUser()) {
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

  const user = getCurrentUser();
  const optId = 'opt_' + Date.now();
  const optimisticComment = {
    comment_id: optId,
    parent_id: parentId,
    user_name: user.name,
    user_avatar: user.picture,
    body: body,
    created_at: new Date().toISOString(),
    isOptimistic: true,
    depth: parentId ? 1 : 0
  };

  // Generate HTML
  const html = parentId ? createCommentHtml(optimisticComment) : createCommentThread(optimisticComment);
  
  // Inject into DOM
  if (parentId) {
    const parentThread = document.querySelector(`.comment[data-comment-id="${parentId}"]`).closest('.comment-thread');
    if (parentThread) {
      let repliesContainer = parentThread.querySelector('.comment-thread__replies');
      if (!repliesContainer) {
        repliesContainer = document.createElement('div');
        repliesContainer.className = 'comment-thread__replies';
        parentThread.appendChild(repliesContainer);
      }
      repliesContainer.insertAdjacentHTML('beforeend', html);
    }
  } else {
    const listEl = document.querySelector(`.video-card__comments-list[data-video-id="${videoId}"]`);
    if (listEl) {
      const empty = listEl.querySelector('.comments-empty');
      if (empty) empty.remove();
      listEl.insertAdjacentHTML('beforeend', html);
    }
  }

  // Update comment count
  const toggleBtn = document.querySelector(`.video-card__comments-toggle[data-video-id="${videoId}"]`);
  let previousCount = 0;
  if (toggleBtn) {
    previousCount = parseInt(toggleBtn.textContent.replace(/[^0-9]/g, '')) || 0;
    toggleBtn.textContent = `💬 ${previousCount + 1} comments`;
  }

  // Hide reply form or clear textarea
  let replyForm = null;
  if (parentId) {
    replyForm = textarea.closest('.reply-form');
    if (replyForm) replyForm.style.display = 'none';
  } else {
    textarea.value = '';
    textarea.dispatchEvent(new Event('input'));
  }

  try {
    const response = await api.postComment(videoId, parentId, body, getToken());
    
    // Success: Update optimistic ID to real ID and remove optimistic class
    const el = document.querySelector(`.comment[data-comment-id="${optId}"]`);
    if (el) {
      el.dataset.commentId = response.comment_id;
      el.classList.remove('comment--optimistic');
      if (!parentId) {
        const actions = el.querySelector('.comment__actions');
        if (actions) {
          actions.innerHTML = `<button class="comment__reply-btn reply-btn" data-comment-id="${response.comment_id}">↩ Reply</button>`;
          attachReplyHandlers(videoId);
        }
      }
    }
    
    if (replyForm) replyForm.remove();
    
    // Update localStorage cache with the new comment count
    updateCachedCommentCount(videoId, previousCount + 1);
    
    // showToast('Comment posted!', 'success'); // Optional, since it's optimistic, UI already updated
  } catch (error) {
    console.error('Failed to post comment:', error);
    
    // Rollback
    const el = document.querySelector(`.comment[data-comment-id="${optId}"]`);
    if (el) {
      const thread = el.closest('.comment-thread');
      if (thread && thread.firstElementChild === el) {
        thread.remove();
      } else {
        el.remove();
      }
    }
    
    if (toggleBtn) {
      toggleBtn.textContent = `💬 ${previousCount} comments`;
    }
    
    if (replyForm) {
      replyForm.style.display = '';
      submitBtn.disabled = false;
    } else {
      textarea.value = body;
      textarea.dispatchEvent(new Event('input'));
    }
    
    showToast('Failed to post comment. Please try again.', 'error');
  } finally {
    if (submitBtn && !replyForm) submitBtn.disabled = false;
  }
}

function attachReplyHandlers(videoId) {
  const card = document.querySelector(`.video-card[data-video-id="${videoId}"]`);
  if (!card) return;

  card.querySelectorAll('.reply-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      toggleReplyForm(videoId, e.currentTarget.dataset.commentId);
    });
  });
}

function toggleReplyForm(videoId, commentId) {
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

  replyForm.querySelector('.reply-cancel-btn').addEventListener('click', () => replyForm.remove());
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
    state.expandedComments.forEach(videoId => updateInlineCommentFormUI(videoId));
  });

  const user = getCurrentUser();
  if (user) {
    updateAuthUI(user);
  } else {
    renderSignInButton(container);
  }
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
    document.getElementById('signout-btn').addEventListener('click', () => signOut());
  } else {
    container.innerHTML = '';
    renderSignInButton(container);
  }
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
  setTimeout(() => toast.remove(), 3000);
}
