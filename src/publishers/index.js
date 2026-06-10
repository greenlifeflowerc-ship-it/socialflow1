import { platformConfigured } from '../config.js';
import { mock } from './mock.js';
import { facebookPublisher } from './facebook.js';
import { instagramPublisher } from './instagram.js';
import { pinterestPublisher } from './pinterest.js';
import { twitterPublisher } from './twitter.js';
import { tiktokPublisher } from './tiktok.js';

const REAL = {
  facebook: facebookPublisher,
  instagram: instagramPublisher,
  pinterest: pinterestPublisher,
  twitter: twitterPublisher,
  tiktok: tiktokPublisher,
};

/**
 * Publish one post to one connected account.
 * Falls back to the mock publisher when the platform is not configured or the
 * account was connected in sandbox mode (no real token).
 */
export async function publishToAccount({ account, tokens, post, mediaAssets }) {
  const platform = account.platform;
  const sandbox = !platformConfigured(platform) || !tokens?.accessToken || account.meta?.sandbox === true;
  const publisher = sandbox ? mock : REAL[platform];
  if (!publisher) throw new Error(`No publisher available for platform "${platform}".`);
  const result = await publisher.publish({ account, tokens, post, mediaAssets });
  return { ...result, sandbox };
}
