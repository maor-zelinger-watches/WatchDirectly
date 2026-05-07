/**
 * Unit tests for js/comments.js
 * 
 * Tests cover:
 * - buildCommentTree(): flat array → nested threaded tree
 * - validateCommentDepth(): depth limit enforcement
 * - createCommentHtml(): HTML generation for comments
 */

import { describe, it, expect } from 'vitest';
import { buildCommentTree, validateCommentDepth, createCommentHtml } from '../../js/comments.js';

const mockComments = [
  {
    comment_id: 'c_001',
    video_id: 'abc123',
    parent_id: '',
    user_name: 'John D.',
    user_avatar: 'https://lh3.googleusercontent.com/photo1',
    body: 'Great review!',
    depth: 0,
    created_at: '2026-05-07T09:00:00Z',
  },
  {
    comment_id: 'c_002',
    video_id: 'abc123',
    parent_id: 'c_001',
    user_name: 'Jane S.',
    user_avatar: 'https://lh3.googleusercontent.com/photo2',
    body: 'Agreed!',
    depth: 1,
    created_at: '2026-05-07T09:05:00Z',
  },
  {
    comment_id: 'c_003',
    video_id: 'abc123',
    parent_id: '',
    user_name: 'Alex K.',
    user_avatar: 'https://lh3.googleusercontent.com/photo3',
    body: 'Does anyone know the price?',
    depth: 0,
    created_at: '2026-05-07T10:00:00Z',
  },
  {
    comment_id: 'c_004',
    video_id: 'abc123',
    parent_id: 'c_001',
    user_name: 'Bob R.',
    user_avatar: 'https://lh3.googleusercontent.com/photo4',
    body: 'Same here!',
    depth: 1,
    created_at: '2026-05-07T09:10:00Z',
  },
];

describe('buildCommentTree', () => {
  it('groups replies under their parent comment', () => {
    const tree = buildCommentTree(mockComments);
    expect(tree).toHaveLength(2); // Two top-level comments
    
    const firstComment = tree.find(c => c.comment_id === 'c_001');
    expect(firstComment.replies).toHaveLength(2); // c_002 and c_004
  });

  it('preserves top-level comments in chronological order', () => {
    const tree = buildCommentTree(mockComments);
    expect(tree[0].comment_id).toBe('c_001');
    expect(tree[1].comment_id).toBe('c_003');
  });

  it('preserves reply order chronologically', () => {
    const tree = buildCommentTree(mockComments);
    const firstComment = tree.find(c => c.comment_id === 'c_001');
    expect(firstComment.replies[0].comment_id).toBe('c_002');
    expect(firstComment.replies[1].comment_id).toBe('c_004');
  });

  it('handles empty array', () => {
    expect(buildCommentTree([])).toEqual([]);
  });

  it('handles comments with no replies', () => {
    const tree = buildCommentTree([mockComments[2]]); // Alex's standalone comment
    expect(tree).toHaveLength(1);
    expect(tree[0].replies).toEqual([]);
  });

  it('top-level comments have empty replies array by default', () => {
    const tree = buildCommentTree(mockComments);
    const alex = tree.find(c => c.comment_id === 'c_003');
    expect(alex.replies).toEqual([]);
  });
});

describe('validateCommentDepth', () => {
  it('allows depth 0 (top-level comment)', () => {
    expect(validateCommentDepth(0)).toBe(true);
  });

  it('allows depth 1 (reply)', () => {
    expect(validateCommentDepth(1)).toBe(true);
  });

  it('rejects depth 2 (too deep)', () => {
    expect(validateCommentDepth(2)).toBe(false);
  });

  it('rejects depth 3', () => {
    expect(validateCommentDepth(3)).toBe(false);
  });

  it('rejects negative depth', () => {
    expect(validateCommentDepth(-1)).toBe(false);
  });
});

describe('createCommentHtml', () => {
  const comment = mockComments[0]; // John's top-level comment

  it('includes the user name', () => {
    const html = createCommentHtml(comment);
    expect(html).toContain('John D.');
  });

  it('includes the comment body', () => {
    const html = createCommentHtml(comment);
    expect(html).toContain('Great review!');
  });

  it('includes user avatar image', () => {
    const html = createCommentHtml(comment);
    expect(html).toContain('<img');
    expect(html).toContain('photo1');
  });

  it('includes a reply button for depth-0 comments', () => {
    const html = createCommentHtml(comment);
    expect(html).toContain('Reply');
  });

  it('does NOT include a reply button for depth-1 comments', () => {
    const reply = mockComments[1]; // Jane's reply (depth 1)
    const html = createCommentHtml(reply);
    expect(html).not.toContain('reply-btn');
  });

  it('adds depth CSS class for indentation', () => {
    const reply = mockComments[1];
    const html = createCommentHtml(reply);
    expect(html).toContain('comment--depth-1');
  });

  it('sanitizes HTML in comment body', () => {
    const malicious = { ...comment, body: '<script>alert("xss")</script>' };
    const html = createCommentHtml(malicious);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
