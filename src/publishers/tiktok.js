import { http, firstMedia } from './helpers.js';

const API = 'https://open.tiktokapis.com/v2';

// Content Posting API via PULL_FROM_URL (Cloudinary URL must be on a verified
// domain for direct post; unaudited apps land content in the user's inbox as a
// draft). Returns the publish_id; final status is async on TikTok's side.
export const tiktokPublisher = {
  async publish({ tokens, post, mediaAssets }) {
    const token = tokens.accessToken;
    const media = firstMedia(mediaAssets);
    if (!media || media.type !== 'video') {
      throw new Error('TikTok publishing here supports a single video (reel).');
    }

    const body = await http(`${API}/post/publish/inbox/video/init/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_info: { source: 'PULL_FROM_URL', video_url: media.url },
      }),
    });
    const publishId = body.data?.publish_id;
    if (!publishId) throw new Error(`TikTok init failed: ${JSON.stringify(body)}`);
    return { platformPostId: publishId, note: 'Sent to TikTok inbox/draft for finalization.' };
  },
};
