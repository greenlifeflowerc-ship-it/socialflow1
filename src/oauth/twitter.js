import { config } from '../config.js';

const SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];

function basicAuth() {
  const { clientId, clientSecret } = config.platforms.twitter;
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

export const twitter = {
  provider: 'twitter',
  usesPkce: true, // OAuth2 PKCE
  scopes: SCOPES,

  buildAuthUrl({ state, redirectUri, codeChallenge }) {
    const p = new URLSearchParams({
      response_type: 'code',
      client_id: config.platforms.twitter.clientId,
      redirect_uri: redirectUri,
      scope: SCOPES.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return `https://twitter.com/i/oauth2/authorize?${p.toString()}`;
  },

  async exchange({ code, redirectUri, codeVerifier }) {
    const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        client_id: config.platforms.twitter.clientId,
      }),
    });
    const tok = await tokenRes.json();
    if (!tok.access_token) throw new Error(`Twitter token exchange failed: ${JSON.stringify(tok)}`);

    let name = 'X account';
    let username = null;
    let accountId = null;
    try {
      const meRes = await fetch('https://api.twitter.com/2/users/me?user.fields=profile_image_url', {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      });
      const me = await meRes.json();
      name = me.data?.name || name;
      username = me.data?.username || null;
      accountId = me.data?.id || null;
    } catch { /* best-effort */ }

    return [{
      platform: 'twitter',
      platformAccountId: accountId,
      accountName: username ? `@${username}` : name,
      accountAvatar: null,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || null,
      expiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null,
      scopes: tok.scope || SCOPES.join(' '),
      meta: { username },
    }];
  },

  async refresh(refreshToken) {
    const res = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.platforms.twitter.clientId,
      }),
    });
    const tok = await res.json();
    if (!tok.access_token) throw new Error(`Twitter refresh failed: ${JSON.stringify(tok)}`);
    return {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || refreshToken,
      expiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null,
      scopes: tok.scope || null,
    };
  },
};
