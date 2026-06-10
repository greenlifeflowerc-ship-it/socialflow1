import { admin } from './supabaseClient.js';
import { encrypt, decrypt } from './crypto.js';

/**
 * Persist (encrypted) tokens for a social account. Writes both the secret row
 * and the non-secret expiry/scopes mirror on social_accounts.
 */
export async function saveTokens(accountId, userId, { accessToken, refreshToken, expiresAt, scopes }) {
  const { error: secErr } = await admin.from('social_account_secrets').upsert({
    account_id: accountId,
    user_id: userId,
    access_token_enc: accessToken != null ? encrypt(accessToken) : null,
    refresh_token_enc: refreshToken != null ? encrypt(refreshToken) : null,
    token_expires_at: expiresAt || null,
    scopes: scopes || null,
  });
  if (secErr) throw secErr;

  await admin
    .from('social_accounts')
    .update({ token_expires_at: expiresAt || null, scopes: scopes || null, status: 'active' })
    .eq('id', accountId);
}

/** Read and decrypt tokens for an account. Returns null if none stored. */
export async function loadTokens(accountId) {
  const { data, error } = await admin
    .from('social_account_secrets')
    .select('access_token_enc, refresh_token_enc, token_expires_at, scopes')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    accessToken: data.access_token_enc ? decrypt(data.access_token_enc) : null,
    refreshToken: data.refresh_token_enc ? decrypt(data.refresh_token_enc) : null,
    expiresAt: data.token_expires_at,
    scopes: data.scopes,
  };
}

/** Mark an account's status (e.g. 'expired' / 'revoked' / 'error'). */
export async function setAccountStatus(accountId, status) {
  await admin.from('social_accounts').update({ status }).eq('id', accountId);
}
