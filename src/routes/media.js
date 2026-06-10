import { Router } from 'express';
import { requireUser } from '../auth.js';
import { signUpload } from '../cloudinary.js';
import { cloudinaryConfigured } from '../config.js';

export const mediaRouter = Router();

// POST /media/sign  -> signature for a direct signed upload to Cloudinary,
// pinned to the user's private folder. The client never sees the API secret.
mediaRouter.post('/sign', requireUser, async (req, res) => {
  if (!cloudinaryConfigured()) {
    return res.status(503).json({ error: 'cloudinary_not_configured' });
  }
  try {
    const { folder = 'root', resourceType = 'auto' } = req.body || {};
    const payload = signUpload(req.user.id, { folder, resourceType });
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
