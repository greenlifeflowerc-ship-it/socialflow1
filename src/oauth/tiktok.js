import { config } from '../config.js';

const SCOPES = ['user.info.basic', 'video.publish', 'video.upload'];

export const tiktok = {
  provider: 'tiktok',
  usesPkce: true,
  scopes: SCOPES,

  buildAuthUrl({ state, redirectUri, codeChallenge }) {
    const p = new URLSearchParams({
      client_key: config.platforms.tiktok.clientKey,
      response_type: 'code',
      scope: SCOPES.join(','),
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return `https://www.tiktok.com/v2/auth/authorize/?${p.toString()}`;
  },

  async exchange({ code, redirectUri, codeVerifier }) {
    const { clientKey, clientSecret } = config.platforms.tiktok;
    const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });
    const tok = await tokenRes.json();
    if (!tok.access_token) throw new Error(`TikTok token exchange failed: ${JSON.stringify(tok)}`);

    let name = 'TikTok account';
    let avatar = null;
    try {
      const meRes = await fetch(
        'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url',
        { headers: { Authorization: `Bearer ${tok.access_token}` } },
      );
      const me = await meRes.json();
      name = me.data?.user?.display_name || name;
      avatar = me.data?.user?.avatar_url || null;
    } catch { /* best-effort */ }

    return [{
      platform: 'tiktok',
      platformAccountId: tok.open_id || null,
      accountName: name,
      accountAvatar: avatar,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || null,
      expiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null,
      scopes: tok.scope || SCOPES.join(','),
      meta: { open_id: tok.open_id },
    }];
  },

  async refresh(refreshToken) {
    const { clientKey, clientSecret } = config.platforms.tiktok;
    const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    const tok = await res.json();
    if (!tok.access_token) throw new Error(`TikTok refresh failed: ${JSON.stringify(tok)}`);
    return {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || refreshToken,
      expiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null,
      scopes: tok.scope || null,
    };
  },
};
