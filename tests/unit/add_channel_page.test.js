/**
 * Unit tests for js/add-channel.js (the operator-only add-channel page).
 *
 * The module wires itself to the page's form on import, so each test builds
 * the form DOM first and imports a fresh copy. fetch is mocked at the
 * network boundary — the same seam the e2e suite uses — so the tests cover
 * the real api.js POST path, including its "status:error becomes a thrown
 * Error" contract.
 */

import { describe, it, expect, vi } from 'vitest';

const FORM_HTML = `
  <form id="add-channel-form">
    <input id="channel-url" type="url">
    <input id="admin-password" type="password">
    <button id="add-channel-submit" type="submit">Add channel</button>
  </form>
  <p id="add-channel-result" hidden></p>
`;

async function mountPage(responseBody) {
  document.body.innerHTML = FORM_HTML;
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => responseBody,
  }));
  vi.resetModules();
  await import('../../js/add-channel.js');
}

async function submit(url, password) {
  document.getElementById('channel-url').value = url;
  document.getElementById('admin-password').value = password;
  document.getElementById('add-channel-form')
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  // Let the async submit handler settle. The handler is fire-and-forget
  // (dispatchEvent doesn't return its promise), so we flush event-loop ticks
  // until fetch has fired — post() now awaits async request signing
  // (crypto.subtle) BEFORE fetch, so a single tick can miss it — then one more
  // tick for the response .then chain.
  for (let i = 0; i < 20 && (!global.fetch.mock || global.fetch.mock.calls.length === 0); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('add-channel page', () => {
  it('posts the URL and password in the request body, never in the URL', async () => {
    await mountPage({ status: 'ok', channel: { channel_name: 'Watch Guy', platform: 'youtube' } });
    await submit('https://www.youtube.com/@WatchGuy', 'sekret');

    const [calledUrl, init] = global.fetch.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(calledUrl).not.toContain('sekret');
    expect(JSON.parse(init.body)).toMatchObject({
      action: 'addChannel',
      url: 'https://www.youtube.com/@WatchGuy',
      token: 'sekret',
    });
  });

  it('shows the resolved channel on success and clears the URL for the next add', async () => {
    await mountPage({ status: 'ok', channel: { channel_name: 'Watch Guy', platform: 'youtube' } });
    await submit('https://www.youtube.com/@WatchGuy', 'sekret');

    const result = document.getElementById('add-channel-result');
    expect(result.hidden).toBe(false);
    expect(result.textContent).toContain('“Watch Guy” was added as a YouTube channel');
    expect(document.getElementById('channel-url').value).toBe('');
    // The password stays in the field for repeat adds (it is never persisted
    // anywhere else — the module has no storage code path at all).
    expect(document.getElementById('admin-password').value).toBe('sekret');
  });

  it('surfaces a backend rejection (wrong password) as an error message', async () => {
    await mountPage({ status: 'error', message: 'Wrong password' });
    await submit('https://news.example', 'nope');

    const result = document.getElementById('add-channel-result');
    expect(result.className).toContain('add-channel__result--error');
    expect(result.textContent).toBe('Wrong password');
    expect(document.getElementById('add-channel-submit').disabled).toBe(false); // re-enabled for retry
  });
});
