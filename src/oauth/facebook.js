import { config } from '../config.js';

// One Meta app drives both Facebook Pages and Instagram (Business/Creator).
const SCOPES = [
  'public_profile',
  'pages_show_list',
  'pages_manage_posts',
  'pages_read_engagement',
  'instagram_basic',
  'instagram_content_publish',
  'business_management',
];

const v = () => config.platforms.facebook.apiVersion;

export const facebook = {
  provider: 'facebook',
  usesPkce: false,
  scopes: SCOPES,

  buildAuthUrl({ state, redirectUri }) {
    const p = new URLSearchParams({
      client_id: config.platforms.facebook.appId,
      redirect_uri: redirectUri,
      state,
      response_type: 'code',
      scope: SCOPES.join(','),
    });
    return `https://www.facebook.com/${v()}/dialog/oauth?${p.toString()}`;
  },

  // Returns the list of connectable accounts (one per Page; plus an Instagram
  // entry for any Page that has a linked IG business account).
  async exchange({ code, redirectUri }) {
    const { appId, appSecret } = config.platforms.facebook;

    // 1) short-lived user token
    const shortRes = await fetch(
      `https://graph.facebook.com/${v()}/oauth/access_token?` +
        new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, client_secret: appSecret, code }),
    );
    const short = await shortRes.json();
    if (!short.access_token) throw new Error(`FB token exchange failed: ${JSON.stringify(short)}`);

    // 2) long-lived user token (~60 days)
    const longRes = await fetch(
      `https://graph.facebook.com/${v()}/oauth/access_token?` +
        new URLSearchParams({
          grant_type: 'fb_exchange_token',
          client_id: appId,
          client_secret: appSecret,
          fb_exchange_token: short.access_token,
        }),
    );
    const long = await longRes.json();
    const userToken = long.access_token || short.access_token;
    const expiresAt = long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null;

    // 3) list pages + their (non-expiring) page tokens + linked IG accounts
    const pagesRes = await fetch(
      `https://graph.facebook.com/${v()}/me/accounts?` +
        new URLSearchParams({
          fields:
            'id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}',
          access_token: userToken,
        }),
    );
    const pages = await pagesRes.json();
    if (!pages.data) throw new Error(`FB pages fetch failed: ${JSON.stringify(pages)}`);

    const accounts = [];
    for (const page of pages.data) {
      accounts.push({
        platform: 'facebook',
        platformAccountId: page.id,
        accountName: page.name,
        accountAvatar: page.picture?.data?.url || null,
        accessToken: page.access_token, // page token (does not expire with long-lived user token)
        refreshToken: null,
        expiresAt: null,
        scopes: SCOPES.join(','),
        meta: { page_id: page.id },
      });
      const ig = page.instagram_business_account;
      if (ig?.id) {
        accounts.push({
          platform: 'instagram',
          platformAccountId: ig.id,
          accountName: ig.username || page.name,
          accountAvatar: ig.profile_picture_url || null,
          accessToken: page.access_token, // IG content publishing uses the page token
          refreshToken: null,
          expiresAt: null,
          scopes: SCOPES.join(','),
          meta: { ig_user_id: ig.id, page_id: page.id },
        });
      }
    }
    if (accounts.length === 0) {
      throw new Error('No Facebook Pages found on this account. Create a Page first (personal profiles are not supported).');
    }
    return accounts;
  },
};
