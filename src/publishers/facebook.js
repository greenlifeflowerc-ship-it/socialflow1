import { config } from '../config.js';
import { http, firstMedia, hasVideo } from './helpers.js';

const v = () => config.platforms.facebook.apiVersion;
const G = (path) => `https://graph.facebook.com/${v()}/${path}`;

// Publishes to a Facebook Page. `account.meta.page_id` + page access token.
export const facebookPublisher = {
  async publish({ account, tokens, post, mediaAssets }) {
    const pageId = account.meta?.page_id || account.platform_account_id;
    const token = tokens.accessToken;
    if (!pageId || !token) throw new Error('Missing Facebook page id or token.');

    const caption = post.caption || '';
    const media = firstMedia(mediaAssets);

    // Text-only post.
    if (!media) {
      const body = await http(G(`${pageId}/feed`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ message: caption, access_token: token }),
      });
      return { platformPostId: body.id };
    }

    // Video (covers reel too — FB consumes reels via the video endpoint).
    if (hasVideo(mediaAssets) || media.type === 'video') {
      const body = await http(G(`${pageId}/videos`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ file_url: media.url, description: caption, access_token: token }),
      });
      return { platformPostId: body.id };
    }

    // Single photo.
    const body = await http(G(`${pageId}/photos`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ url: media.url, caption, access_token: token }),
    });
    return { platformPostId: body.post_id || body.id };
  },
};
