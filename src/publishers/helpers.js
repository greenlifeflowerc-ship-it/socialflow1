/** POST/GET JSON with helpful error surfacing. */
export async function http(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = body?.error?.message || body?.error_description || body?.message || text || res.statusText;
    const err = new Error(`${res.status} ${msg}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export const firstMedia = (assets) => (assets && assets.length ? assets[0] : null);
export const hasVideo = (assets) => (assets || []).some((a) => a.type === 'video');
