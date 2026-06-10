import { config } from '../config.js';
import { http, firstMedia } from './helpers.js';

// Instagram API with Instagram Login publishes via graph.instagram.com using
// the IG user's long-lived token. 2-step: create container, then publish.
const ver = () => config.platforms.instagram.graphVersion;
const G = (path) => `https://graph.instagram.com/${ver()}/${path}`;

export const instagramPublisher = {
  async publish({ account, tokens, post, mediaAssets }) {
    const igUserId = account.meta?.ig_user_id || account.platform_account_id;
    const token = tokens.accessToken;
    if (!igUserId || !token) throw new Error('Missing Instagram user id or token.');

    const media = firstMedia(mediaAssets);
    if (!media) throw new Error('Instagram requires at least one media item.');

    const params = { access_token: token };
    if (post.content_type === 'story') {
      params.media_type = 'STORIES';
      if (media.type === 'video') params.video_url = media.url; else params.image_url = media.url;
    } else if (post.content_type === 'reel') {
      params.media_type = 'REELS';
      params.video_url = media.url;
      params.caption = post.caption || '';
    } else {
      params.caption = post.caption || '';
      if (media.type === 'video') params.video_url = media.url; else params.image_url = media.url;
    }

    // 1) create media container
    const container = await http(G(`${igUserId}/media`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    const creationId = container.id;
    if (!creationId) throw new Error('Instagram did not return a creation id.');

    // 2) publish (video/reels may need a moment to finish processing)
    let lastErr;
    for (let i = 0; i < 6; i++) {
      try {
        const pub = await http(G(`${igUserId}/media_publish`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ creation_id: creationId, access_token: token }),
        });
        return { platformPostId: pub.id };
      } catch (e) {
        lastErr = e;
        if (media.type === 'video' && i < 5) { await new Promise((r) => setTimeout(r, 5000)); continue; }
        throw e;
      }
    }
    throw lastErr;
  },
};
