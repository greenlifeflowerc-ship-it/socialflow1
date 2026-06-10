import { Router } from 'express';
import { requireUser } from '../auth.js';
import { admin } from '../supabaseClient.js';
import { publishNow, runDuePosts } from '../scheduler.js';
import { config } from '../config.js';

export const postsRouter = Router();

// POST /posts/:id/publish-now  — verify ownership, then publish immediately.
postsRouter.post('/:id/publish-now', requireUser, async (req, res) => {
  const postId = req.params.id;
  // Ownership is derived from the verified token — never from the client.
  const { data: post } = await admin
    .from('posts')
    .select('id, user_id')
    .eq('id', postId)
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (!post) return res.status(404).json({ error: 'not_found' });

  // Reset retryable targets and mark the post due now.
  await admin.from('post_targets').update({ status: 'pending', attempts: 0, error_message: null })
    .eq('post_id', postId).neq('status', 'published');
  await admin.from('posts').update({ status: 'scheduled', scheduled_at: new Date().toISOString() })
    .eq('id', postId);

  try {
    await publishNow(postId);
    const { data: targets } = await admin.from('post_targets').select('*').eq('post_id', postId);
    const { data: updated } = await admin.from('posts').select('status').eq('id', postId).maybeSingle();
    res.json({ status: updated?.status, targets });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Internal trigger for external schedulers (Render Cron Job / Supabase pg_cron)
// when the in-process loop is disabled. Protected by a shared secret.
export const internalRouter = Router();
internalRouter.post('/run-due', async (req, res) => {
  if (!config.scheduler.cronSecret || req.headers['x-cron-secret'] !== config.scheduler.cronSecret) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const result = await runDuePosts();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
