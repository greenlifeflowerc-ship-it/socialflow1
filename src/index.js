import express from 'express';
import cors from 'cors';
import { config, cloudinaryConfigured, platformConfigured } from './config.js';
import { oauthRouter } from './routes/oauth.js';
import { mediaRouter } from './routes/media.js';
import { postsRouter, internalRouter } from './routes/posts.js';
import { startScheduler } from './scheduler.js';
import { CONNECTABLE } from './oauth/index.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.json({
    service: 'schudlaaa-server',
    ok: true,
    scheduler: config.scheduler.enabled ? 'in-process' : 'external',
    cloudinary: cloudinaryConfigured(),
    platforms: Object.fromEntries(CONNECTABLE.map((p) => [p, platformConfigured(p) ? 'live' : 'sandbox'])),
  });
});
app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/oauth', oauthRouter);
app.use('/media', mediaRouter);
app.use('/posts', postsRouter);
app.use('/internal', internalRouter);

app.use((err, _req, res, _next) => {
  console.error('unhandled error:', err);
  res.status(500).json({ error: 'internal_error' });
});

app.listen(config.port, () => {
  console.log(`[server] listening on :${config.port}`);
  if (!config.supabase.url) console.warn('[server] SUPABASE_URL not set — configure .env');
  startScheduler();
});
