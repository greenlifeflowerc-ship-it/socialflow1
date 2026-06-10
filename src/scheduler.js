import cron from 'node-cron';
import { admin } from './supabaseClient.js';
import { loadTokens, saveTokens, setAccountStatus } from './tokens.js';
import { refreshIfPossible } from './oauth/index.js';
import { publishToAccount } from './publishers/index.js';
import { config } from './config.js';

const MAX_ATTEMPTS = 3;
const BACKOFF_MIN = [1, 5, 15]; // minutes before retry per attempt

async function log(post, accountId, event, detail) {
  try {
    await admin.from('post_logs').insert({
      post_id: post.id,
      social_account_id: accountId,
      user_id: post.user_id,
      event,
      detail: detail ? String(detail).slice(0, 2000) : null,
    });
  } catch (e) {
    console.error('log insert failed:', e.message);
  }
}

async function resolveMedia(post) {
  if (!post.media_ids || post.media_ids.length === 0) return [];
  const { data } = await admin
    .from('media_assets')
    .select('id, url, thumbnail_url, type')
    .in('id', post.media_ids)
    .eq('user_id', post.user_id);
  // Preserve the order the user arranged them in.
  const byId = new Map((data || []).map((m) => [m.id, m]));
  return post.media_ids.map((id) => byId.get(id)).filter(Boolean);
}

async function getFreshTokens(account) {
  let tokens = await loadTokens(account.id);
  if (!tokens) return null;
  const soon = Date.now() + 5 * 60 * 1000;
  if (tokens.expiresAt && new Date(tokens.expiresAt).getTime() < soon && tokens.refreshToken) {
    try {
      const refreshed = await refreshIfPossible(account.platform, tokens.refreshToken);
      if (refreshed) {
        await saveTokens(account.id, account.user_id, refreshed);
        tokens = { ...tokens, ...refreshed };
      }
    } catch (e) {
      await setAccountStatus(account.id, 'expired');
      throw new Error(`Token refresh failed: ${e.message}`);
    }
  }
  return tokens;
}

async function postFirstComment(account, tokens, platformPostId, text) {
  if (!text || !platformPostId) return;
  try {
    if (account.platform === 'facebook') {
      const v = config.platforms.facebook.apiVersion;
      await fetch(`https://graph.facebook.com/${v}/${platformPostId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ message: text, access_token: tokens.accessToken }),
      });
    } else if (account.platform === 'instagram') {
      const v = config.platforms.instagram.graphVersion;
      await fetch(`https://graph.instagram.com/${v}/${platformPostId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ message: text, access_token: tokens.accessToken }),
      });
    }
  } catch { /* first comment is best-effort */ }
}

async function publishTarget(post, target, mediaAssets) {
  // Load the account (non-secret metadata).
  const { data: account } = await admin
    .from('social_accounts')
    .select('*')
    .eq('id', target.social_account_id)
    .maybeSingle();
  if (!account) {
    await admin.from('post_targets').update({ status: 'failed', error_message: 'Connected account no longer exists.' }).eq('id', target.id);
    await log(post, target.social_account_id, 'target_failed', 'account missing');
    return 'failed';
  }

  await admin.from('post_targets').update({ status: 'publishing', attempts: target.attempts + 1 }).eq('id', target.id);

  try {
    const tokens = await getFreshTokens(account);
    const result = await publishToAccount({ account, tokens, post, mediaAssets });

    if (post.first_comment && !result.sandbox) {
      await postFirstComment(account, tokens, result.platformPostId, post.first_comment);
    }

    await admin.from('post_targets').update({
      status: 'published',
      platform_post_id: result.platformPostId,
      error_message: result.note || null,
      published_at: new Date().toISOString(),
    }).eq('id', target.id);
    await log(post, account.id, 'target_published',
      `${result.sandbox ? '[sandbox] ' : ''}${account.platform} id=${result.platformPostId}${result.note ? ' — ' + result.note : ''}`);
    return 'published';
  } catch (e) {
    const attempts = target.attempts + 1;
    const giveUp = attempts >= MAX_ATTEMPTS;
    await admin.from('post_targets').update({
      status: giveUp ? 'failed' : 'pending',
      error_message: String(e.message || e).slice(0, 1000),
    }).eq('id', target.id);
    await log(post, account.id, giveUp ? 'target_failed' : 'target_retry',
      `attempt ${attempts}/${MAX_ATTEMPTS}: ${e.message}`);
    return giveUp ? 'failed' : 'retry';
  }
}

async function processPost(post) {
  await admin.from('posts').update({ status: 'publishing' }).eq('id', post.id);
  await log(post, null, 'post_publishing', `Scheduled time reached (${post.scheduled_at}).`);

  const mediaAssets = await resolveMedia(post);

  // Targets not yet done and still within the retry budget.
  const { data: targets } = await admin
    .from('post_targets')
    .select('*')
    .eq('post_id', post.id)
    .in('status', ['pending', 'failed'])
    .lt('attempts', MAX_ATTEMPTS);

  const results = [];
  for (const t of targets || []) {
    results.push(await publishTarget(post, t, mediaAssets));
  }

  // Recompute the post's overall status from ALL its targets.
  const { data: allTargets } = await admin.from('post_targets').select('status').eq('post_id', post.id);
  const statuses = (allTargets || []).map((t) => t.status);
  const anyRetryable = statuses.includes('pending');
  const published = statuses.filter((s) => s === 'published').length;
  const total = statuses.length;

  if (anyRetryable) {
    const maxAttempts = Math.max(0, ...(targets || []).map((t) => t.attempts + 1));
    const delay = BACKOFF_MIN[Math.min(maxAttempts, BACKOFF_MIN.length - 1)];
    const next = new Date(Date.now() + delay * 60 * 1000).toISOString();
    await admin.from('posts').update({ status: 'scheduled', scheduled_at: next }).eq('id', post.id);
    await log(post, null, 'post_retry_scheduled', `Retrying ${delay} min later (${next}).`);
  } else if (published === total && total > 0) {
    await admin.from('posts').update({ status: 'published' }).eq('id', post.id);
    await log(post, null, 'post_published', `All ${total} target(s) published.`);
  } else if (published > 0) {
    await admin.from('posts').update({ status: 'partial' }).eq('id', post.id);
    await log(post, null, 'post_partial', `${published}/${total} target(s) published.`);
  } else {
    await admin.from('posts').update({ status: 'failed' }).eq('id', post.id);
    await log(post, null, 'post_failed', 'All targets failed.');
  }
}

let running = false;

/** Scan for due posts and publish them. Safe to call repeatedly / concurrently-guarded. */
export async function runDuePosts() {
  if (running) return { skipped: true };
  running = true;
  try {
    const nowIso = new Date().toISOString();
    const { data: due, error } = await admin
      .from('posts')
      .select('*')
      .eq('status', 'scheduled')
      .lte('scheduled_at', nowIso)
      .limit(50);
    if (error) throw error;
    for (const post of due || []) {
      try {
        await processPost(post);
      } catch (e) {
        console.error(`processPost ${post.id} failed:`, e.message);
        await admin.from('posts').update({ status: 'failed' }).eq('id', post.id);
        await log(post, null, 'post_error', e.message);
      }
    }
    return { processed: (due || []).length };
  } finally {
    running = false;
  }
}

/** Publish a single post immediately ("Publish now" / sandbox testing). */
export async function publishNow(postId) {
  const { data: post } = await admin.from('posts').select('*').eq('id', postId).maybeSingle();
  if (!post) throw new Error('Post not found.');
  await processPost(post);
}

let task = null;
export function startScheduler() {
  if (!config.scheduler.enabled) {
    console.log('[scheduler] disabled (SCHEDULER_ENABLED=false). Drive it via POST /internal/run-due.');
    return;
  }
  if (task) return;
  task = cron.schedule('* * * * *', () => {
    runDuePosts()
      .then((r) => r.processed ? console.log(`[scheduler] processed ${r.processed} due post(s)`) : null)
      .catch((e) => console.error('[scheduler] run failed:', e.message));
  });
  console.log('[scheduler] in-process cron started (every minute).');
}

// Allow running the worker standalone: `node src/scheduler.js`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('scheduler.js')) {
  startScheduler();
  runDuePosts().catch((e) => console.error(e));
}
