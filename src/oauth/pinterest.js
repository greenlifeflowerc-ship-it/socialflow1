import { config } from '../config.js';

const SCOPES = ['boards:read', 'pins:read', 'pins:write', 'user_accounts:read'];

function basicAuth() {
  const { appId, appSecret } = config.platforms.pinterest;
  return 'Basic ' + Buffer.from(`${appId}:${appSecret}`).toString('base64');
}

export const pinterest = {
  provider: 'pinterest',
  usesPkce: false,
  scopes: SCOPES,

  buildAuthUrl({ state, redirectUri }) {
    const p = new URLSearchParams({
      client_id: config.platforms.pinterest.appId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(','),
      state,
    });
    return `https://www.pinterest.com/oauth/?${p.toString()}`;
  },

  async exchange({ code, redirectUri }) {
    const tokenRes = await fetch('https://api.pinterest.com/v5/oauth/token', {
      method: 'POST',
      headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    });
    const tok = await tokenRes.json();
    if (!tok.access_token) throw new Error(`Pinterest token exchange failed: ${JSON.stringify(tok)}`);

    let name = 'Pinterest account';
    let avatar = null;
    let accountId = null;
    try {
      const meRes = await fetch('https://api.pinterest.com/v5/user_account', {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      });
      const me = await meRes.json();
      name = me.username || name;
      avatar = me.profile_image || null;
      accountId = me.username || me.id || null;
    } catch { /* profile fetch is best-effort */ }

    return [{
      platform: 'pinterest',
      platformAccountId: accountId,
      accountName: name,
      accountAvatar: avatar,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || null,
      expiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null,
      scopes: tok.scope || SCOPES.join(','),
      meta: {},
    }];
  },

  async refresh(refreshToken) {
    const res = await fetch('https://api.pinterest.com/v5/oauth/token', {
      method: 'POST',
      headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    const tok = await res.json();
    if (!tok.access_token) throw new Error(`Pinterest refresh failed: ${JSON.stringify(tok)}`);
    return {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || refreshToken,
      expiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null,
      scopes: tok.scope || null,
    };
  },
};
