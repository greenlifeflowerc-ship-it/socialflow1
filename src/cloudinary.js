import { v2 as cloudinary } from 'cloudinary';
import { config, cloudinaryConfigured } from './config.js';

if (cloudinaryConfigured()) {
  cloudinary.config({
    cloud_name: config.cloudinary.cloudName,
    api_key: config.cloudinary.apiKey,
    api_secret: config.cloudinary.apiSecret,
    secure: true,
  });
}

/**
 * Produce a signature for a direct (client -> Cloudinary) signed upload,
 * pinned to the user's private folder `users/<uid>/...` (plan §5).
 * The client never sees the API secret.
 */
export function signUpload(userId, { folder = 'root', resourceType = 'auto' } = {}) {
  if (!cloudinaryConfigured()) {
    throw new Error('Cloudinary is not configured on the server.');
  }
  const timestamp = Math.round(Date.now() / 1000);
  const safeFolder = String(folder).replace(/[^a-zA-Z0-9_\-\/]/g, '').slice(0, 80) || 'root';
  const fullFolder = `users/${userId}/${safeFolder}`;

  // Only the params we sign are enforced server-side.
  const paramsToSign = { folder: fullFolder, timestamp };
  const signature = cloudinary.utils.api_sign_request(paramsToSign, config.cloudinary.apiSecret);

  return {
    signature,
    timestamp,
    apiKey: config.cloudinary.apiKey,
    cloudName: config.cloudinary.cloudName,
    folder: fullFolder,
    resourceType,
    uploadUrl: `https://api.cloudinary.com/v1_1/${config.cloudinary.cloudName}/${resourceType}/upload`,
  };
}

/** Build a derived thumbnail URL for an asset. */
export function thumbnailUrl(publicId, type) {
  if (!cloudinaryConfigured() || !publicId) return null;
  return cloudinary.url(publicId, {
    resource_type: type === 'video' ? 'video' : 'image',
    format: 'jpg',
    transformation: [{ width: 400, height: 400, crop: 'fill', quality: 'auto' }],
  });
}

export { cloudinary };
