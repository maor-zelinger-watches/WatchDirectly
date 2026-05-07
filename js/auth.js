/**
 * auth.js — Google Sign-In integration for WatchDirectly
 * 
 * Uses Google Identity Services (GIS) for one-tap sign-in.
 * Manages user session state and provides the ID token for comment authentication.
 */

/**
 * @typedef {Object} User
 * @property {string} name - Display name
 * @property {string} email - Email address
 * @property {string} picture - Avatar URL
 * @property {string} token - Google ID token (for API auth)
 */

/** @type {User|null} */
let currentUser = null;

/** @type {string} */
let _clientId = '';

/** @type {Function[]} */
const listeners = [];

/**
 * Initializes Google Sign-In.
 * Call this once after the Google Identity Services SDK has loaded.
 * 
 * @param {string} clientId - Google OAuth 2.0 Client ID
 */
export function initAuth(clientId) {
  _clientId = clientId;

  if (typeof google === 'undefined' || !google.accounts) {
    console.warn('Google Identity Services SDK not loaded');
    return;
  }

  // Restore session from localStorage (GIS doesn't persist across refresh)
  const saved = localStorage.getItem('wd_user');
  if (saved) {
    try {
      currentUser = JSON.parse(saved);
      notifyListeners();
    } catch (e) {
      localStorage.removeItem('wd_user');
    }
  }

  google.accounts.id.initialize({
    client_id: clientId,
    callback: handleCredentialResponse,
    auto_select: true,
  });

  // Only show the one-tap prompt if user isn't already signed in
  if (!currentUser) {
    google.accounts.id.prompt();
  }
}

/**
 * Renders the Google Sign-In button in a container element.
 * 
 * @param {HTMLElement} container - DOM element to render the button in
 */
export function renderSignInButton(container) {
  if (typeof google === 'undefined' || !google.accounts) return;

  google.accounts.id.renderButton(container, {
    theme: 'filled_black',
    size: 'medium',
    shape: 'pill',
    text: 'signin_with',
  });
}

/**
 * Handles the credential response from Google Sign-In.
 * Decodes the JWT to extract user info (without verification — that happens server-side).
 * 
 * @param {Object} response - Google credential response
 */
function handleCredentialResponse(response) {
  const token = response.credential;

  try {
    // Decode the JWT payload (base64) to get user info
    // Note: actual verification happens server-side in Apps Script
    const payload = JSON.parse(atob(token.split('.')[1]));

    currentUser = {
      name: payload.name || payload.email.split('@')[0],
      email: payload.email,
      picture: payload.picture || '',
      token: token,
    };

    // Persist to localStorage so session survives refresh
    localStorage.setItem('wd_user', JSON.stringify(currentUser));

    notifyListeners();
  } catch (error) {
    console.error('Failed to decode credential:', error);
  }
}

/**
 * Signs out the current user.
 */
export function signOut() {
  if (typeof google !== 'undefined' && google.accounts) {
    google.accounts.id.disableAutoSelect();
  }
  currentUser = null;
  localStorage.removeItem('wd_user');
  notifyListeners();
}

/**
 * Gets the currently signed-in user.
 * @returns {User|null}
 */
export function getCurrentUser() {
  return currentUser;
}

/**
 * Checks if a user is currently signed in.
 * @returns {boolean}
 */
export function isSignedIn() {
  return currentUser !== null;
}

/**
 * Gets the Google ID token for API authentication.
 * @returns {string|null}
 */
export function getToken() {
  return currentUser ? currentUser.token : null;
}

/**
 * Checks if the stored token is expired or about to expire (within 5 min buffer).
 * @returns {boolean}
 */
export function isTokenExpired() {
  if (!currentUser || !currentUser.token) return true;
  try {
    const payload = JSON.parse(atob(currentUser.token.split('.')[1]));
    const expiresAt = payload.exp * 1000; // JWT exp is in seconds
    return Date.now() > expiresAt - 5 * 60 * 1000; // 5 min buffer
  } catch {
    return true;
  }
}

/**
 * Refreshes the Google ID token by requesting a fresh credential via GIS.
 * Returns a promise that resolves with the new token or null if refresh fails.
 * 
 * @returns {Promise<string|null>} Fresh token or null
 */
export function refreshToken() {
  return new Promise((resolve) => {
    if (typeof google === 'undefined' || !google.accounts) {
      resolve(null);
      return;
    }

    // Set a timeout — if GIS doesn't respond in 5s, give up
    const timeout = setTimeout(() => {
      resolve(null);
    }, 5000);

    // Temporarily override the callback to capture the fresh token
    google.accounts.id.initialize({
      client_id: _clientId,
      callback: (response) => {
        clearTimeout(timeout);
        handleCredentialResponse(response);
        resolve(currentUser ? currentUser.token : null);
      },
      auto_select: true,
    });

    google.accounts.id.prompt((notification) => {
      // If prompt was dismissed or skipped, resolve null
      if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
        clearTimeout(timeout);
        resolve(null);
      }
    });
  });
}

/**
 * Registers a callback for auth state changes.
 * @param {Function} callback - Called with (user: User|null)
 */
export function onAuthChange(callback) {
  listeners.push(callback);
}

/**
 * Notifies all auth state listeners.
 */
function notifyListeners() {
  for (const listener of listeners) {
    try {
      listener(currentUser);
    } catch (e) {
      console.error('Auth listener error:', e);
    }
  }
}
