import 'dotenv/config';

function bool(v, dflt = false) {
  if (v === undefined) return dflt;
  return String(v).toLowerCase() === 'true' || v === '1';
}

export const config = {
  port: parseInt(process.env.PORT || '8080', 10),
  // On Render, RENDER_EXTERNAL_URL is injected automatically, so PUBLIC_BASE_URL
  // doesn't need to be set by hand.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:8080').replace(/\/$/, ''),
  appReturnUrl: process.env.APP_RETURN_URL || 'http://localhost:3000/#/accounts',

  supabase: {
    url: process.env.SUPABASE_URL || '',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },

  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY || '',

  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
  },

  scheduler: {
    enabled: bool(process.env.SCHEDULER_ENABLED, true),
    cronSecret: process.env.CRON_SECRET || '',
  },

  platforms: {
    facebook: {
      appId: process.env.FB_APP_ID || process.env.META_APP_ID || '',
      appSecret: process.env.FB_APP_SECRET || process.env.META_APP_SECRET || '',
      apiVersion: process.env.FB_API_VERSION || process.env.META_GRAPH_VERSION || 'v21.0',
      // Facebook Login for Business: config_id from the app's login configuration.
      loginConfigId: process.env.FB_LOGIN_CONFIG_ID || '',
    },
    // Instagram API with Instagram Login — its own app id/secret.
    instagram: {
      appId: process.env.INSTAGRAM_APP_ID || '',
      appSecret: process.env.INSTAGRAM_APP_SECRET || '',
      scopes: process.env.INSTAGRAM_SCOPES || '',
      graphVersion: process.env.IG_GRAPH_VERSION || process.env.META_GRAPH_VERSION || 'v21.0',
    },
    pinterest: {
      appId: process.env.PINTEREST_APP_ID || '',
      appSecret: process.env.PINTEREST_APP_SECRET || '',
    },
    twitter: {
      clientId: process.env.TWITTER_CLIENT_ID || '',
      clientSecret: process.env.TWITTER_CLIENT_SECRET || '',
    },
    tiktok: {
      clientKey: process.env.TIKTOK_CLIENT_KEY || '',
      clientSecret: process.env.TIKTOK_CLIENT_SECRET || '',
    },
  },
};

/** True when a platform has real OAuth credentials configured. */
export function platformConfigured(platform) {
  if (platform === 'facebook') {
    const fb = config.platforms.facebook;
    return !!(fb.appId && fb.appSecret);
  }
  if (platform === 'instagram') {
    const ig = config.platforms.instagram;
    return !!(ig.appId && ig.appSecret);
  }
  const p = config.platforms[platform];
  if (!p) return false;
  if (platform === 'pinterest') return !!(p.appId && p.appSecret);
  if (platform === 'twitter') return !!(p.clientId && p.clientSecret);
  if (platform === 'tiktok') return !!(p.clientKey && p.clientSecret);
  return false;
}

export function cloudinaryConfigured() {
  const c = config.cloudinary;
  return !!(c.cloudName && c.apiKey && c.apiSecret);
}
