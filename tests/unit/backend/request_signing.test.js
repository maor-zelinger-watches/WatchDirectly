/**
 * Executable tests for the request-signing gate (SEC-Sybil), evaluating the
 * REAL apps-script/Code.gs against in-memory stubs.
 *
 * The gate is a phased-rollout speed bump layered on top of the Google-token
 * auth: the frontend HMAC-signs write POSTs, and `enforceRequestSignature`
 * rejects a missing/invalid/stale signature ONLY once the Meta
 * `require_signature` toggle is 'true' (before that it soft-passes so a backend
 * deploy can precede the signing frontend). These tests pin:
 *   - a valid signature passes (returns null → handler proceeds);
 *   - soft launch (toggle off/absent): a bad/missing signature still passes;
 *   - enforced (toggle 'true'): missing, tampered, wrong-action, and stale
 *     signatures are all rejected;
 *   - unsigned actions (e.g. clientError, addChannel) are never gated.
 *
 * The HMAC is backed by Node's crypto so a signature computed the way the
 * FRONTEND computes it (js/api.js) is accepted here — the cross-runtime
 * canonicalization contract, not a self-referential stub.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '../../../apps-script/Code.gs'), 'utf-8');
const SECRET = SRC.match(/REQUEST_SIGNING_SECRET\s*=\s*'([^']+)'/)[1];
const nowSec = () => Math.floor(Date.now() / 1000);

/** base64url WITH padding — matches Apps Script's Utilities.base64EncodeWebSafe. */
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

/** The signature a correct client sends for (action, ts). Mirrors both runtimes. */
function sign(action, ts) {
  const mac = crypto.createHmac('sha256', SECRET).update(`${action}\n${ts}`).digest();
  return b64url(mac);
}

/** A META sheet stub whose rows drive getMeta(); `metaRows` is [key, value] pairs. */
function metaSheet(metaRows) {
  const grid = [['key', 'value'], ...metaRows.map((r) => r.slice())];
  return {
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getLastRow: () => grid.length,
    getRange: () => ({ setValue() {}, setValues() { return this; }, setNumberFormat() { return this; } }),
    appendRow: (r) => { grid.push(r.slice()); },
  };
}

/** Eval Code.gs with a REAL HMAC (Node crypto) and a META stub; return named fns. */
function loadBackend(metaRows = []) {
  const meta = metaSheet(metaRows);
  const ss = { getSheets: () => [meta], getSheetByName: () => null, insertSheet: () => meta };
  const globals = {
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{}' }) },
    SpreadsheetApp: { openById: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    Utilities: {
      computeHmacSha256Signature: (msg, key) =>
        crypto.createHmac('sha256', key).update(String(msg)).digest(),
      base64EncodeWebSafe: (bytes) => b64url(bytes),
      getUuid: () => '00000000-0000-0000-0000-000000000000',
      computeDigest: () => [], sleep() {},
      DigestAlgorithm: { MD5: 'MD5', SHA_256: 'SHA_256' },
    },
    Logger: { log() {} },
    ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }), MimeType: { JSON: 'json' } },
    ScriptApp: {}, XmlService: {},
  };
  const names = [
    'enforceRequestSignature', 'isRequestSignatureValid', 'isSignatureRequired', 'computeRequestSignature',
  ];
  const factory = new Function(...Object.keys(globals), `${SRC}\nreturn { ${names.join(', ')} };`);
  return factory(...Object.values(globals));
}

describe('request signing — signature validity (isRequestSignatureValid)', () => {
  const be = loadBackend();

  it('accepts a fresh, correctly-signed request (frontend canonicalization)', () => {
    const ts = nowSec();
    expect(be.isRequestSignatureValid({ action: 'vote', ts, sig: sign('vote', ts) })).toBe(true);
  });

  it('rejects a missing signature or timestamp', () => {
    const ts = nowSec();
    expect(be.isRequestSignatureValid({ action: 'vote', ts })).toBe(false);
    expect(be.isRequestSignatureValid({ action: 'vote', sig: sign('vote', ts) })).toBe(false);
  });

  it('rejects a signature lifted onto a different action', () => {
    const ts = nowSec();
    // A valid signature for 'myVotes' must not authorize a 'vote' write.
    expect(be.isRequestSignatureValid({ action: 'vote', ts, sig: sign('myVotes', ts) })).toBe(false);
  });

  it('rejects a stale timestamp beyond the skew window', () => {
    const ts = nowSec() - 6 * 60; // 6 min old — outside the 5-min window
    expect(be.isRequestSignatureValid({ action: 'vote', ts, sig: sign('vote', ts) })).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const ts = nowSec();
    expect(be.isRequestSignatureValid({ action: 'vote', ts, sig: sign('vote', ts) + 'x' })).toBe(false);
  });
});

describe('request signing — enforcement gate (enforceRequestSignature)', () => {
  it('is a no-op for unsigned actions regardless of the toggle', () => {
    const be = loadBackend([['require_signature', 'true']]);
    expect(be.isSignatureRequired()).toBe(true);
    // clientError / addChannel are not in SIGNED_ACTIONS — never gated.
    expect(be.enforceRequestSignature({ action: 'clientError' })).toBe(null);
    expect(be.enforceRequestSignature({ action: 'addChannel', token: 'pw' })).toBe(null);
  });

  it('soft-launch (toggle off): passes a signed action even with no/invalid signature', () => {
    const be = loadBackend(); // no require_signature row
    expect(be.isSignatureRequired()).toBe(false);
    expect(be.enforceRequestSignature({ action: 'vote' })).toBe(null);
    expect(be.enforceRequestSignature({ action: 'vote', ts: nowSec(), sig: 'bogus' })).toBe(null);
  });

  it('enforced (toggle on): rejects a signed action with a missing/invalid signature', () => {
    const be = loadBackend([['require_signature', 'true']]);
    const miss = be.enforceRequestSignature({ action: 'vote' });
    expect(miss).toMatchObject({ status: 'error' });
    expect(miss.message).toMatch(/signature/i);

    const bad = be.enforceRequestSignature({ action: 'vote', ts: nowSec(), sig: 'bogus' });
    expect(bad).toMatchObject({ status: 'error' });
  });

  it('enforced (toggle on): passes a signed action with a valid signature', () => {
    const be = loadBackend([['require_signature', 'true']]);
    const ts = nowSec();
    expect(be.enforceRequestSignature({ action: 'vote', ts, sig: sign('vote', ts) })).toBe(null);
  });
});
