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

/** @type {Function[]} */
const listeners = [];

/**
 * Initializes Google Sign-In.
 * Call this once after the Google Identity Services SDK has loaded.
 * 
 * @param {string} clientId - Google OAuth 2.0 Client ID
 */
export function initAuth(clientId) {
  if (typeof google === 'undefined' || !google.accounts) {
    console.warn('Google Identity Services SDK not loaded');
    return;
  }

  google.accounts.id.initialize({
    client_id: clientId,
    callback: handleCredentialResponse,
    auto_select: true,
  });
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
