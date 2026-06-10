import { http } from './helpers.js';

// OAuth2 user-context bearer can create tweets (tweet.write). Note: uploading
// media to X requires a separate media-upload step that is not available to a
// pure OAuth2 token on all tiers, so this publisher posts the text/caption and
// records a note when media was attached but could not be uploaded.
export const twitterPublisher = {
  async publish({ tokens, post, mediaAssets }) {
    const token = tokens.accessToken;
    const text = (post.caption || '').slice(0, 280);
    if (!text) throw new Error('A tweet needs text (media-only tweets need media upload, not available here).');

    const body = await http('https://api.twitter.com/2/tweets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const id = body.data?.id;
    const note = (mediaAssets && mediaAssets.length)
      ? ' (text posted; media upload not supported on this API tier)'
      : '';
    return { platformPostId: id, note: note || undefined };
  },
};
