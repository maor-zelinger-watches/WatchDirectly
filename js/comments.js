/**
 * comments.js — Comment system for WatchDirectly
 * 
 * Handles comment threading, depth validation, and HTML rendering.
 * Max depth: 1 (top-level + one reply level).
 */

import { timeAgo, sanitizeHtml } from './utils.js';

const MAX_DEPTH = 1;

/**
 * Builds a nested comment tree from a flat array of comments.
 * Top-level comments (depth 0, no parent_id) become root nodes.
 * Replies (depth 1, with parent_id) are nested under their parent.
 * 
 * @param {Object[]} comments - Flat array of comment objects
 * @returns {Object[]} Tree of comments with `.replies` arrays
 */
export function buildCommentTree(comments) {
  if (!comments || comments.length === 0) return [];

  // Separate top-level and replies
  const topLevel = [];
  const replies = [];

  for (const comment of comments) {
    if (!comment.parent_id) {
      topLevel.push({ ...comment, replies: [] });
    } else {
      replies.push(comment);
    }
  }

  // Sort top-level by created_at (chronological)
  topLevel.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  // Create a map for quick lookup
  const commentMap = new Map();
  for (const comment of topLevel) {
    commentMap.set(comment.comment_id, comment);
  }

  // Attach replies to their parents (sorted chronologically)
  replies.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  for (const reply of replies) {
    const parent = commentMap.get(reply.parent_id);
    if (parent) {
      parent.replies.push(reply);
    }
  }

  return topLevel;
}

/**
 * Validates whether a comment at the given depth is allowed.
 * Max depth is 1 (top-level = 0, reply = 1).
 * 
 * @param {number} depth - The depth to validate
 * @returns {boolean} True if the depth is valid
 */
export function validateCommentDepth(depth) {
  return Number.isInteger(depth) && depth >= 0 && depth <= MAX_DEPTH;
}

/**
 * Creates an HTML string for a single comment.
 * Includes user avatar, name, time, body text, and reply button (for depth-0 only).
 * 
 * @param {Object} comment - Comment object
 * @returns {string} HTML string
 */
export function createCommentHtml(comment) {
  const escapedBody = sanitizeHtml(comment.body);
  const escapedName = sanitizeHtml(comment.user_name);
  const escapedId = sanitizeHtml(comment.comment_id);
  const escapedAvatar = sanitizeHtml(comment.user_avatar);
  const depth = comment.depth || 0;

  const replyButton = (depth === 0 && !comment.isOptimistic)
    ? `<button class="comment__reply-btn reply-btn" data-comment-id="${escapedId}">↩ Reply</button>`
    : '';

  const optimisticClass = comment.isOptimistic ? ' comment--optimistic' : '';

  return `
    <div class="comment comment--depth-${depth}${optimisticClass}" data-comment-id="${escapedId}">
      <div class="comment__avatar">
        <img src="${escapedAvatar}" alt="${escapedName}" class="comment__avatar-img" referrerpolicy="no-referrer" />
      </div>
      <div class="comment__body">
        <div class="comment__header">
          <span class="comment__author">${escapedName}</span>
          <span class="comment__separator">·</span>
          <span class="comment__time">${timeAgo(comment.created_at)}</span>
        </div>
        <p class="comment__text">${escapedBody}</p>
        <div class="comment__actions">
          ${replyButton}
        </div>
      </div>
    </div>
  `.trim();
}

/**
 * Renders a full comment thread (top-level comment + its replies).
 * 
 * @param {Object} comment - Top-level comment with `.replies` array
 * @returns {string} HTML string for the thread
 */
export function createCommentThread(comment) {
  const mainComment = createCommentHtml(comment);
  const replies = (comment.replies || [])
    .map(reply => createCommentHtml(reply))
    .join('\n');

  return `
    <div class="comment-thread">
      ${mainComment}
      ${replies ? `<div class="comment-thread__replies">${replies}</div>` : ''}
    </div>
  `.trim();
}
