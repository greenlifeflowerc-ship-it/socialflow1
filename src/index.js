import express from 'express';
import cors from 'cors';
import { config, cloudinaryConfigured, platformConfigured } from './config.js';
import { oauthRouter, instagramCallbackHandler } from './routes/oauth.js';
import { mediaRouter } from './routes/media.js';
import { postsRouter, internalRouter } from './routes/posts.js';
import { startScheduler } from './scheduler.js';
import { CONNECTABLE } from './oauth/index.js';
import { pagesRouter } from './routes/pages.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Machine-readable status (for debugging / monitoring).
app.get('/status', (_req, res) => {
  res.json({
    service: 'schudlaaa-server',
    rev: 'r7-fb-config',
    ok: true,
    scheduler: config.scheduler.enabled ? 'in-process' : 'external',
    cloudinary: cloudinaryConfigured(),
    // app IDs / config id are public (they appear in OAuth URLs) — for diagnostics
    igAppId: config.platforms.instagram.appId || null,
    fbAppId: config.platforms.facebook.appId || null,
    fbConfigId: config.platforms.facebook.loginConfigId || null,
    platforms: Object.fromEntries(CONNECTABLE.map((p) => [p, platformConfigured(p) ? 'live' : 'sandbox'])),
  });
});
app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/oauth', oauthRouter);
// Instagram's redirect uses a path already whitelisted in the Meta app.
app.get('/api/auth/instagram/callback', instagramCallbackHandler);
app.use('/media', mediaRouter);
app.use('/posts', postsRouter);
app.use('/internal', internalRouter);

// Public info + legal pages (/, /privacy, /terms, /data-deletion, /api/health).
app.use('/', pagesRouter);

app.use((err, _req, res, _next) => {
  console.error('unhandled error:', err);
  res.status(500).json({ error: 'internal_error' });
});

app.listen(config.port, () => {
  console.log(`[server] listening on :${config.port}`);
  if (!config.supabase.url) console.warn('[server] SUPABASE_URL not set — configure .env');
  startScheduler();
});
