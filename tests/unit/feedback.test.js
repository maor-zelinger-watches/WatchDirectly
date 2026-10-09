/**
 * Unit tests for js/feedback.js — the floating "Send feedback" button and
 * its dialog.
 *
 * Covers: the button showing only for a signed-in user (and hiding, with
 * the dialog closed, on sign-out), open/close plumbing (button, ✕, backdrop,
 * Escape, focus return), the sender note, the empty-message guard, the
 * token on every POST, the one-in-flight guard, and that a failed send
 * keeps the draft while a successful one clears and closes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendFeedback: vi.fn(),
  getCurrentUser: vi.fn(),
  ensureToken: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../js/api-client.js', () => ({
  api: { sendFeedback: mocks.sendFeedback },
}));
vi.mock('../../js/auth.js', () => ({
  getCurrentUser: mocks.getCurrentUser,
  ensureToken: mocks.ensureToken,
}));
vi.mock('../../js/toast.js', () => ({ showToast: mocks.showToast }));

import { setupFeedback, openFeedback, closeFeedback, feedbackOnAuthChange } from '../../js/feedback.js';

const overlay = () => document.getElementById('feedback-overlay');
const isOpen = () => !overlay().hidden;
const fab = () => document.getElementById('feedback-fab');
const textarea = () => document.getElementById('feedback-message');
const submitBtn = () => document.getElementById('feedback-submit');
const note = () => document.getElementById('feedback-identity');
const form = () => document.getElementById('feedback-form');

const flush = () => new Promise((r) => setTimeout(r, 0));
const USER = { email: 'me@example.com', name: 'Me', token: 't' };

async function submit() {
  form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.getCurrentUser.mockReturnValue(USER);
  mocks.ensureToken.mockResolvedValue('tok');
  mocks.sendFeedback.mockResolvedValue({ status: 'ok', feedback_id: 'f1' });
  document.body.innerHTML = `
    <div id="toast-container"></div>
    <button class="feedback-fab" id="feedback-fab" type="button" aria-label="Send feedback" hidden></button>
    <div class="feedback-overlay" id="feedback-overlay" hidden>
      <div class="feedback-overlay__backdrop" data-close></div>
      <form class="feedback-overlay__dialog" id="feedback-form" role="dialog" aria-modal="true" tabindex="-1" novalidate>
        <button type="button" class="feedback-overlay__close" data-close aria-label="Close">✕</button>
        <h2 id="feedback-title">Send feedback</h2>
        <textarea id="feedback-message" maxlength="2000"></textarea>
        <p id="feedback-identity"></p>
        <button type="submit" id="feedback-submit">Submit</button>
      </form>
    </div>`;
  setupFeedback();
});

describe('visibility — signed-in only', () => {
  it('setup shows the button for a signed-in user', () => {
    expect(fab().hidden).toBe(false);
  });

  it('setup leaves the button hidden when signed out', () => {
    mocks.getCurrentUser.mockReturnValue(null);
    document.getElementById('feedback-fab').hidden = true;
    setupFeedback();
    expect(fab().hidden).toBe(true);
  });

  it('sign-in shows it, sign-out hides it and closes an open dialog', () => {
    feedbackOnAuthChange(null);
    expect(fab().hidden).toBe(true);
    feedbackOnAuthChange(USER);
    expect(fab().hidden).toBe(false);
    openFeedback();
    expect(isOpen()).toBe(true);
    feedbackOnAuthChange(null);
    expect(fab().hidden).toBe(true);
    expect(isOpen()).toBe(false);
  });

  it('openFeedback refuses when signed out', () => {
    mocks.getCurrentUser.mockReturnValue(null);
    openFeedback();
    expect(isOpen()).toBe(false);
    expect(mocks.showToast).toHaveBeenCalledWith(expect.stringMatching(/sign in/i), 'info');
  });
});

describe('open / close', () => {
  it('the dialog starts hidden and the floating button opens it with the textarea focused', () => {
    expect(isOpen()).toBe(false);
    fab().click();
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(textarea());
  });

  it('✕ closes it and returns focus to the button', () => {
    fab().focus();
    fab().click();
    overlay().querySelector('.feedback-overlay__close').click();
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(fab());
  });

  it('the backdrop closes it', () => {
    openFeedback();
    overlay().querySelector('.feedback-overlay__backdrop').click();
    expect(isOpen()).toBe(false);
  });

  it('Escape closes it only while open', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(isOpen()).toBe(false);
    openFeedback();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(isOpen()).toBe(false);
  });

  it('closing keeps the draft for the next open this page load', () => {
    openFeedback();
    textarea().value = 'half-written';
    closeFeedback();
    openFeedback();
    expect(textarea().value).toBe('half-written');
  });

  it('names the sender under the box', () => {
    openFeedback();
    expect(note().textContent).toContain('me@example.com');
  });
});

describe('submit', () => {
  it('an empty (or whitespace) message sends nothing and nudges the sender', async () => {
    openFeedback();
    textarea().value = '   ';
    await submit();
    expect(mocks.sendFeedback).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith(expect.stringMatching(/write something/i), 'info');
    expect(isOpen()).toBe(true);
  });

  it('posts the trimmed message with the (renewed) token, clears, closes, thanks', async () => {
    mocks.ensureToken.mockResolvedValue('fresh');
    openFeedback();
    textarea().value = '  The Shorts chip hides articles too  ';
    await submit();
    expect(mocks.sendFeedback).toHaveBeenCalledWith('The Shorts chip hides articles too', 'fresh');
    expect(textarea().value).toBe('');
    expect(isOpen()).toBe(false);
    expect(mocks.showToast).toHaveBeenCalledWith(expect.stringMatching(/thanks/i), 'success');
  });

  it('a failed send keeps the draft, re-enables the form and shows the error', async () => {
    mocks.sendFeedback.mockRejectedValue(new Error('Too much feedback right now'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    openFeedback();
    textarea().value = 'keep me';
    await submit();
    expect(isOpen()).toBe(true);
    expect(textarea().value).toBe('keep me');
    expect(textarea().disabled).toBe(false);
    expect(submitBtn().disabled).toBe(false);
    expect(mocks.showToast).toHaveBeenCalledWith('Too much feedback right now', 'error');
    spy.mockRestore();
  });

  it('an old backend ("Unknown action") gets a friendlier message', async () => {
    mocks.sendFeedback.mockRejectedValue(new Error('Unknown action: feedback'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    openFeedback();
    textarea().value = 'hi';
    await submit();
    expect(mocks.showToast).toHaveBeenCalledWith(expect.stringMatching(/available yet/i), 'error');
    spy.mockRestore();
  });

  it('a session that cannot be renewed surfaces as an error and nothing is sent', async () => {
    mocks.ensureToken.mockRejectedValue(new Error('Session expired. Please sign in again.'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    openFeedback();
    textarea().value = 'hi';
    await submit();
    expect(mocks.sendFeedback).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith(expect.stringMatching(/session expired/i), 'error');
    spy.mockRestore();
  });

  it('a second submit while one is in flight is ignored (one gesture, one POST)', async () => {
    let resolve;
    mocks.sendFeedback.mockReturnValue(new Promise((r) => { resolve = r; }));
    openFeedback();
    textarea().value = 'once';
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(submitBtn().disabled).toBe(true);
    expect(textarea().disabled).toBe(true);
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(mocks.sendFeedback).toHaveBeenCalledTimes(1);
    resolve({ status: 'ok' });
    await flush();
    expect(isOpen()).toBe(false);
  });
});
