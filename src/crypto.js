import crypto from 'node:crypto';
import { config } from './config.js';

// AES-256-GCM. Key is 32 bytes, provided via TOKEN_ENCRYPTION_KEY (base64 or hex).
function loadKey() {
  const raw = config.tokenEncryptionKey;
  if (!raw) {
    throw new Error('TOKEN_ENCRYPTION_KEY is not set — cannot encrypt/decrypt tokens.');
  }
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }
  if (key.length !== 32) {
    throw new Error(`TOKEN_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}).`);
  }
  return key;
}

/** Encrypt a plaintext string -> "iv.tag.ciphertext" (all base64). */
export function encrypt(plaintext) {
  if (plaintext == null) return null;
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

/** Decrypt "iv.tag.ciphertext" back to plaintext. */
export function decrypt(payload) {
  if (payload == null) return null;
  const key = loadKey();
  const [ivB64, tagB64, dataB64] = String(payload).split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed ciphertext.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}

// ---- helpers used by OAuth (PKCE, state) ----
export function randomUrlSafe(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256Base64Url(input) {
  return crypto.createHash('sha256').update(input).digest('base64url');
}
