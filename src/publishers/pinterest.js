import { http, firstMedia } from './helpers.js';

const API = 'https://api.pinterest.com/v5';

export const pinterestPublisher = {
  async publish({ account, tokens, post, mediaAssets }) {
    const token = tokens.accessToken;
    const media = firstMedia(mediaAssets);
    if (!media) throw new Error('Pinterest requires an image or video to create a Pin.');

    // A Pin needs a board. Use the one chosen at connect time, else the first.
    let boardId = account.meta?.board_id;
    if (!boardId) {
      const boards = await http(`${API}/boards?page_size=1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      boardId = boards.items?.[0]?.id;
      if (!boardId) throw new Error('No Pinterest board found. Create a board first.');
    }

    const media_source =
      media.type === 'video'
        ? { source_type: 'video_url', url: media.url, cover_image_url: media.thumbnail_url || undefined }
        : { source_type: 'image_url', url: media.url };

    const body = await http(`${API}/pins`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        board_id: boardId,
        title: (post.caption || '').slice(0, 100) || undefined,
        description: post.caption || undefined,
        media_source,
      }),
    });
    return { platformPostId: body.id };
  },
};
