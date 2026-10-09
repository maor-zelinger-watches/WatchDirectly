/**
 * Unit tests for js/toast.js (FE16).
 *
 * Two guards: a missing #toast-container is a no-op (never a thrown
 * "appendChild of null"), and a burst of toasts is capped so it can't stack
 * an unbounded column that covers the screen — the oldest are evicted.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { showToast } from '../../js/toast.js';

describe('showToast — missing container (FE16)', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('no-ops silently when #toast-container is absent', () => {
    expect(() => showToast('hello')).not.toThrow();
    expect(document.querySelector('.toast')).toBeNull();
  });
});

describe('showToast — concurrent cap (FE16)', () => {
  let container;
  beforeEach(() => {
    document.body.innerHTML = '<div id="toast-container"></div>';
    container = document.getElementById('toast-container');
  });

  it('caps the number of toasts stacked at once', () => {
    for (let i = 0; i < 10; i++) showToast(`msg ${i}`, 'info');
    expect(container.querySelectorAll('.toast').length).toBeLessThanOrEqual(4);
  });

  it('keeps the newest toasts and evicts the oldest', () => {
    showToast('a'); showToast('b'); showToast('c'); showToast('d'); showToast('e');
    const texts = [...container.querySelectorAll('.toast')].map(t => t.textContent);
    expect(texts).toEqual(['b', 'c', 'd', 'e']); // 'a' evicted, order preserved
  });

  it('renders under the cap normally (no eviction)', () => {
    showToast('one', 'success');
    showToast('two', 'error');
    const toasts = container.querySelectorAll('.toast');
    expect(toasts.length).toBe(2);
    expect(toasts[0].className).toContain('toast--success');
    expect(toasts[1].className).toContain('toast--error');
  });
});
