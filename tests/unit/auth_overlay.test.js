/**
 * Unit tests for js/auth-overlay.js — the sign-in overlay's consent flow.
 *
 * Covers: reconcile semantics (prompt only on an explicit null; an old
 * backend's missing key never prompts), the same-overlay step handoff after
 * signing in through it, explicit yes/no recording, the dismiss-asks-later
 * rule within one load, and the signed-out guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  emailConsent: vi.fn(),
  isSignedIn: vi.fn(),
  ensureToken: vi.fn(),
  renderSignInButton: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../js/api-client.js', () => ({
  api: { emailConsent: mocks.emailConsent },
}));
vi.mock('../../js/auth.js', () => ({
  isSignedIn: mocks.isSignedIn,
  ensureToken: mocks.ensureToken,
  renderSignInButton: mocks.renderSignInButton,
}));
vi.mock('../../js/toast.js', () => ({ showToast: mocks.showToast }));

import {
  setupAuthOverlay, openAuthOverlay, closeAuthOverlay,
  authOverlayOnAuthChange, reconcileMyEmailConsent, __test__,
} from '../../js/auth-overlay.js';
import { state } from '../../js/state.js';

const overlay = () => document.getElementById('auth-overlay');
const overlayOpen = () => !overlay().hidden;
const title = () => document.getElementById('auth-overlay-title').textContent;
const consentBtn = (v) => overlay().querySelector(`[data-consent="${v}"]`);

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.isSignedIn.mockReturnValue(true);
  mocks.ensureToken.mockResolvedValue('tok');
  state.emailConsent = undefined;
  __test__.resetPromptLatch(); // the once-per-load prompt guard is module state
  document.body.innerHTML = `
    <div id="toast-container"></div>
    <div class="auth-overlay" id="auth-overlay" hidden>
      <div class="auth-overlay__backdrop" data-close></div>
      <div class="auth-overlay__dialog" role="dialog" aria-modal="true" aria-labelledby="auth-overlay-title" tabindex="-1">
        <button class="auth-overlay__close" data-close aria-label="Close">✕</button>
        <h2 class="auth-overlay__title" id="auth-overlay-title"></h2>
        <div class="auth-overlay__body"></div>
      </div>
    </div>`;
  setupAuthOverlay();
});

describe('reconcileMyEmailConsent', () => {
  it('an old backend (no marketing_consent key) sets nothing and never prompts', async () => {
    await reconcileMyEmailConsent(Promise.resolve({ video_ids: [], channels: [] }));
    expect(state.emailConsent).toBe(undefined);
    expect(overlayOpen()).toBe(false);
  });

  it("an answered consent ('yes') lands in state without opening the overlay", async () => {
    await reconcileMyEmailConsent(Promise.resolve({ marketing_consent: 'yes' }));
    expect(state.emailConsent).toBe('yes');
    expect(overlayOpen()).toBe(false);
  });

  it('null (never answered) opens the overlay at the consent question', async () => {
    await reconcileMyEmailConsent(Promise.resolve({ marketing_consent: null }));
    expect(state.emailConsent).toBe(null);
    expect(overlayOpen()).toBe(true);
    expect(title()).toMatch(/one more thing/i);
    expect(consentBtn('yes')).toBeTruthy();
    expect(consentBtn('no')).toBeTruthy();
  });

  it('a dismissed prompt does not re-open on a later reconcile this load', async () => {
    await reconcileMyEmailConsent(Promise.resolve({ marketing_consent: null }));
    closeAuthOverlay(); // user dismissed without answering
    await reconcileMyEmailConsent(Promise.resolve({ marketing_consent: null }));
    expect(overlayOpen()).toBe(false); // asks again next load, not this one
  });

  it('signing in through the overlay hands the SAME overlay to the question', async () => {
    openAuthOverlay('signin');
    authOverlayOnAuthChange({ email: 'm@example.com' }); // holding state
    expect(title()).toMatch(/signed in/i);
    await reconcileMyEmailConsent(Promise.resolve({ marketing_consent: null }));
    expect(overlayOpen()).toBe(true);
    expect(title()).toMatch(/one more thing/i);
  });

  it('signing in through the overlay just closes it when consent is already answered', async () => {
    openAuthOverlay('signin');
    authOverlayOnAuthChange({ email: 'm@example.com' });
    await reconcileMyEmailConsent(Promise.resolve({ marketing_consent: 'no' }));
    expect(overlayOpen()).toBe(false);
    expect(state.emailConsent).toBe('no');
  });
});

describe('recording a choice', () => {
  it('"Yes, email me" POSTs consent:true and closes on success', async () => {
    mocks.emailConsent.mockResolvedValue({ marketing_consent: 'yes' });
    await reconcileMyEmailConsent(Promise.resolve({ marketing_consent: null }));

    consentBtn('yes').click();
    await new Promise(r => setTimeout(r, 0));

    expect(mocks.emailConsent).toHaveBeenCalledWith(true, 'tok');
    expect(state.emailConsent).toBe('yes');
    expect(overlayOpen()).toBe(false);
    expect(mocks.showToast).toHaveBeenCalledWith("You're on the list.", 'success');
  });

  it('"No thanks" POSTs consent:false', async () => {
    mocks.emailConsent.mockResolvedValue({ marketing_consent: 'no' });
    openAuthOverlay('consent');

    consentBtn('no').click();
    await new Promise(r => setTimeout(r, 0));

    expect(mocks.emailConsent).toHaveBeenCalledWith(false, 'tok');
    expect(state.emailConsent).toBe('no');
    expect(overlayOpen()).toBe(false);
  });

  it('a failed POST keeps the overlay open, re-enables buttons, and toasts', async () => {
    mocks.emailConsent.mockRejectedValue(new Error('boom'));
    openAuthOverlay('consent');

    consentBtn('yes').click();
    await new Promise(r => setTimeout(r, 0));

    expect(overlayOpen()).toBe(true);
    expect(consentBtn('yes').disabled).toBe(false);
    expect(mocks.showToast).toHaveBeenCalledWith('boom', 'error');
  });

  it('signed out, a consent click asks to sign in instead of POSTing', async () => {
    openAuthOverlay('consent');
    mocks.isSignedIn.mockReturnValue(false);

    consentBtn('yes').click();
    await new Promise(r => setTimeout(r, 0));

    expect(mocks.emailConsent).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith('Please sign in first', 'info');
  });
});

describe('overlay chrome', () => {
  it('sign-out closes the overlay and forgets the consent snapshot', () => {
    state.emailConsent = 'yes';
    openAuthOverlay('prefs');
    authOverlayOnAuthChange(null);
    expect(overlayOpen()).toBe(false);
    expect(state.emailConsent).toBe(undefined);
  });

  it('Escape and the ✕ both close without recording anything', () => {
    openAuthOverlay('consent');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(overlayOpen()).toBe(false);

    openAuthOverlay('consent');
    overlay().querySelector('.auth-overlay__close').click();
    expect(overlayOpen()).toBe(false);

    expect(mocks.emailConsent).not.toHaveBeenCalled();
  });

  it('the prefs view marks the current choice', () => {
    state.emailConsent = 'yes';
    openAuthOverlay('prefs');
    expect(title()).toMatch(/email preferences/i);
    expect(consentBtn('yes').getAttribute('aria-pressed')).toBe('true');
    expect(consentBtn('no').getAttribute('aria-pressed')).toBe('false');
  });
});
