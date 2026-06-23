// server/signature.js
// Generates Zoom Meeting SDK JWT signatures (HS256).
// This module's ONLY job is JWT generation. It makes no network calls and
// never reads process.env directly — credentials are passed in as arguments.

import jwt from 'jsonwebtoken';

const TOKEN_TTL_SECONDS = 2 * 60 * 60; // 2 hours
const ROLE_PARTICIPANT = 0;
const ROLE_HOST = 1;
const DIGITS_ONLY = /^\d+$/;

/**
 * Generate a Meeting SDK signature (JWT, HS256).
 *
 * @param {string} sdkKey    - Zoom Client ID (appKey). Passed in, never read from env here.
 * @param {string} sdkSecret - Zoom Client Secret. Used only to sign; never returned or logged.
 * @param {string} meetingNumber - Digits-only meeting number.
 * @param {number} [role=0] - 0 = participant, 1 = host. MVP always uses 0.
 * @returns {string} signed JWT
 */
export function generateSignature(sdkKey, sdkSecret, meetingNumber, role = ROLE_PARTICIPANT) {
  if (!sdkKey || !sdkSecret) {
    throw new Error('generateSignature: sdkKey and sdkSecret are required');
  }

  const mn = String(meetingNumber).trim();
  if (!DIGITS_ONLY.test(mn)) {
    throw new Error('generateSignature: meetingNumber must contain digits only');
  }

  const normalizedRole = role === ROLE_HOST ? ROLE_HOST : ROLE_PARTICIPANT;

  const iat = Math.floor(Date.now() / 1000) - 30; // backdate 30s to tolerate clock skew
  const exp = iat + TOKEN_TTL_SECONDS;

  // v6 SDK: use appKey only. Including sdkKey here triggers a deprecation
  // warning ("sdkKey will be deprecated in the signature after v5.0.0").
  const payload = {
    appKey: sdkKey,
    mn,
    role: normalizedRole,
    iat,
    exp,
    tokenExp: exp,
  };

  return jwt.sign(payload, sdkSecret, { algorithm: 'HS256' });
}

export { ROLE_PARTICIPANT, ROLE_HOST };
