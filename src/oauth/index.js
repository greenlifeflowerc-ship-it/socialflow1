import { config, platformConfigured } from '../config.js';
import { encrypt, decrypt, randomUrlSafe, sha256Base64Url } from '../crypto.js';
import { facebook } from './facebook.js';
import { pinterest } from './pinterest.js';
import { twitter } from './twitter.js';
import { tiktok } from './tiktok.js';

// Provider that handles each connectable platform. Instagram is connected via
// the Facebook (Meta) flow, so it maps to the same provider.
const PROVIDERS = { facebook, instagram: facebook, pinterest, twitter, tiktok };

export const CONNECTABLE = ['facebook', 'instagram', 'pinterest', 'twitter', 'tiktok'];

export function getProvider(platform) {
  return PROVIDERS[platform] || null;
}

// redirect_uri is per-provider; register this exact URL in each platform app.
export function redirectUriFor(provider) {
  return `${config.publicBaseUrl}/oauth/${provider}/callback`;
}

// OAuth `state` carries everything we need to complete the flow without
// server-side session storage: it's an AES-256-GCM encrypted JSON blob.
export function encodeState(obj) {
  return encrypt(JSON.stringify({ ...obj, ts: Date.now() }));
}
export function decodeState(state) {
  const obj = JSON.parse(decrypt(state));
  if (!obj.ts || Date.now() - obj.ts > 15 * 60 * 1000) throw new Error('OAuth state expired.');
  return obj;
}

export function makePkce() {
  const verifier = randomUrlSafe(48);
  const challenge = sha256Base64Url(verifier);
  return { verifier, challenge };
}

export function isConfigured(platform) {
  return platformConfigured(platform);
}

/** Refresh tokens for a stored account if the provider supports it. */
export async function refreshIfPossible(platform, refreshToken) {
  const provider = getProvider(platform);
  if (!provider?.refresh || !refreshToken) return null;
  return provider.refresh(refreshToken);
}

export { PROVIDERS };
