import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

if (!config.supabase.url || !config.supabase.serviceRoleKey) {
  console.warn(
    '[server] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — set them in .env. ' +
      'The server will boot but database calls will fail until configured.',
  );
}

// Use a placeholder when unset so the process boots with a clear warning
// rather than throwing at import time.
const url = config.supabase.url || 'http://localhost:54321';
const serviceKey = config.supabase.serviceRoleKey || 'placeholder-service-role-key';

/**
 * Service-role client. Bypasses RLS — use ONLY on the server for trusted
 * operations (reading encrypted tokens, the scheduler writing statuses).
 */
export const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/**
 * Validate a Supabase access token (from the Flutter client) and return the
 * authenticated user, or null. Uses the anon key + the provided JWT, so the
 * lookup is scoped to that user.
 */
export async function getUserFromToken(accessToken) {
  if (!accessToken) return null;
  // Validating a user JWT needs any valid project key; fall back to the
  // service-role key when SUPABASE_ANON_KEY isn't configured on the server.
  const key = config.supabase.anonKey || config.supabase.serviceRoleKey;
  const client = createClient(config.supabase.url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const { data, error } = await client.auth.getUser(accessToken);
  if (error || !data?.user) return null;
  return data.user;
}
