import { config, platformConfigured } from '../config.js';
import { encrypt, decrypt, randomUrlSafe, sha256Base64Url } from '../crypto.js';
import { facebook } from './facebook.js';
import { instagram } from './instagram.js';
import { pinterest } from './pinterest.js';
import { twitter } from './twitter.js';
import { tiktok } from './tiktok.js';

// Provider per connectable platform. Instagram uses the Instagram Login flow
// (its own app id/secret), separate from the Facebook (Meta) flow.
const PROVIDERS = { facebook, instagram, pinterest, twitter, tiktok };

export const CONNECTABLE = ['facebook', 'instagram', 'pinterest', 'twitter', 'tiktok'];

export function getProvider(platform) {
  return PROVIDERS[platform] || null;
}

// redirect_uri is per-provider; register this exact URL in each platform app.
export function redirectUriFor(provider) {
  // Instagram: reuse the path already whitelisted in the Meta app
  // (/api/auth/instagram/callback) so no Meta change is needed.
  if (provider === 'instagram') return `${config.publicBaseUrl}/api/auth/instagram/callback`;
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
