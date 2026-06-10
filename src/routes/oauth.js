import { Router } from 'express';
import { requireUser } from '../auth.js';
import { admin } from '../supabaseClient.js';
import { saveTokens } from '../tokens.js';
import { config } from '../config.js';
import {
  CONNECTABLE, getProvider, redirectUriFor, encodeState, decodeState, makePkce, isConfigured,
} from '../oauth/index.js';

export const oauthRouter = Router();

function appReturn(params) {
  const sep = config.appReturnUrl.includes('?') ? '&' : '?';
  return `${config.appReturnUrl}${sep}${new URLSearchParams(params)}`;
}

async function createOrUpdateAccount(userId, acc) {
  const { data: existing } = await admin
    .from('social_accounts')
    .select('id')
    .eq('user_id', userId)
    .eq('platform', acc.platform)
    .eq('platform_account_id', acc.platformAccountId || '')
    .maybeSingle();

  let accountId;
  if (existing) {
    accountId = existing.id;
    await admin.from('social_accounts').update({
      account_name: acc.accountName,
      account_avatar: acc.accountAvatar,
      status: 'active',
      meta: acc.meta || {},
      token_expires_at: acc.expiresAt || null,
      scopes: acc.scopes || null,
    }).eq('id', accountId);
  } else {
    const { data: inserted, error } = await admin.from('social_accounts').insert({
      user_id: userId,
      platform: acc.platform,
      platform_account_id: acc.platformAccountId || null,
      account_name: acc.accountName,
      account_avatar: acc.accountAvatar,
      status: 'active',
      meta: acc.meta || {},
      token_expires_at: acc.expiresAt || null,
      scopes: acc.scopes || null,
    }).select('id').single();
    if (error) throw error;
    accountId = inserted.id;
  }

  if (acc.accessToken) {
    await saveTokens(accountId, userId, {
      accessToken: acc.accessToken,
      refreshToken: acc.refreshToken,
      expiresAt: acc.expiresAt,
      scopes: acc.scopes,
    });
  }
  return accountId;
}

// GET /oauth/:platform/start  — called by the authed client; returns either a
// provider auth URL to open in the browser, or performs a sandbox connect.
oauthRouter.get('/:platform/start', requireUser, async (req, res) => {
  const platform = req.params.platform;
  if (!CONNECTABLE.includes(platform)) return res.status(400).json({ error: 'unknown platform' });

  const provider = getProvider(platform);

  if (!isConfigured(platform)) {
    // No real credentials → connect a sandbox account so the flow is testable.
    const acc = {
      platform,
      platformAccountId: `sandbox_${platform}_${Date.now().toString(36)}`,
      accountName: `${platform[0].toUpperCase() + platform.slice(1)} (sandbox)`,
      accountAvatar: null,
      meta: { sandbox: true },
    };
    const id = await createOrUpdateAccount(req.user.id, acc);
    return res.json({ sandbox: true, accountId: id });
  }

  const pkce = provider.usesPkce ? makePkce() : null;
  const state = encodeState({ u: req.user.id, platform, provider: provider.provider, v: pkce?.verifier });
  const url = provider.buildAuthUrl({
    state,
    redirectUri: redirectUriFor(provider.provider),
    codeChallenge: pkce?.challenge,
  });
  res.json({ url });
});

// GET /oauth/:provider/callback — the provider redirects the browser here.
// Identity + PKCE verifier are recovered from the encrypted state, so no
// session storage is needed.
oauthRouter.get('/:provider/callback', async (req, res) => {
  const providerName = req.params.provider;
  const { code, state, error: oauthError, error_description } = req.query;
  try {
    if (oauthError) throw new Error(error_description || oauthError);
    if (!code || !state) throw new Error('Missing code/state.');

    const decoded = decodeState(state);
    const provider = getProvider(providerName);
    if (!provider) throw new Error('Unknown provider.');

    const accounts = await provider.exchange({
      code,
      redirectUri: redirectUriFor(providerName),
      codeVerifier: decoded.v,
    });

    let count = 0;
    for (const acc of accounts) {
      await createOrUpdateAccount(decoded.u, acc);
      count++;
    }
    res.redirect(appReturn({ connected: providerName, count: String(count) }));
  } catch (e) {
    console.error('oauth callback error:', e.message);
    res.redirect(appReturn({ error: String(e.message || e).slice(0, 200) }));
  }
});
