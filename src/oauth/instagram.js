import { config } from '../config.js';

// Instagram API with Instagram Login (not the Facebook Login flow).
// Uses the Instagram App ID/Secret and instagram.com/oauth/authorize, then
// publishes via graph.instagram.com.
const DEFAULT_SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
  'instagram_business_manage_comments',
  'instagram_business_manage_messages',
];

const scopeStr = () => config.platforms.instagram.scopes || DEFAULT_SCOPES.join(',');
const ver = () => config.platforms.instagram.graphVersion;

export const instagram = {
  provider: 'instagram',
  usesPkce: false,
  scopes: DEFAULT_SCOPES,

  buildAuthUrl({ state, redirectUri }) {
    const p = new URLSearchParams({
      client_id: config.platforms.instagram.appId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopeStr(),
      state,
    });
    return `https://www.instagram.com/oauth/authorize?${p.toString()}`;
  },

  async exchange({ code, redirectUri }) {
    const { appId, appSecret } = config.platforms.instagram;

    // 1) short-lived token (+ user_id)
    const tokenRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code,
      }),
    });
    const raw = await tokenRes.json();
    const short = raw.access_token ? raw : (raw.data && raw.data[0]) || {};
    if (!short.access_token) throw new Error(`Instagram token exchange failed: ${JSON.stringify(raw)}`);

    // 2) long-lived token (~60 days)
    const longRes = await fetch(
      'https://graph.instagram.com/access_token?' +
        new URLSearchParams({
          grant_type: 'ig_exchange_token',
          client_secret: appSecret,
          access_token: short.access_token,
        }),
    );
    const long = await longRes.json();
    const accessToken = long.access_token || short.access_token;
    const expiresAt = long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null;

    // 3) profile
    let username = 'Instagram';
    let avatar = null;
    let igUserId = short.user_id != null ? String(short.user_id) : null;
    try {
      const meRes = await fetch(
        `https://graph.instagram.com/${ver()}/me?` +
          new URLSearchParams({ fields: 'user_id,username,profile_picture_url', access_token: accessToken }),
      );
      const me = await meRes.json();
      username = me.username || username;
      avatar = me.profile_picture_url || null;
      if (me.user_id != null) igUserId = String(me.user_id);
    } catch { /* best-effort */ }

    return [{
      platform: 'instagram',
      platformAccountId: igUserId,
      accountName: username ? `@${username}` : 'Instagram',
      accountAvatar: avatar,
      accessToken,
      // IG long-lived tokens refresh using the token itself, so stash it as the
      // "refresh token" to drive the scheduler's refresh path.
      refreshToken: accessToken,
      expiresAt,
      scopes: scopeStr(),
      meta: { ig_user_id: igUserId, login: 'instagram' },
    }];
  },

  async refresh(token) {
    const res = await fetch(
      'https://graph.instagram.com/refresh_access_token?' +
        new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token }),
    );
    const long = await res.json();
    if (!long.access_token) throw new Error(`Instagram refresh failed: ${JSON.stringify(long)}`);
    return {
      accessToken: long.access_token,
      refreshToken: long.access_token,
      expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null,
      scopes: null,
    };
  },
};
