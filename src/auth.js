import { getUserFromToken } from './supabaseClient.js';

/**
 * Express middleware: require a valid Supabase access token.
 * The server NEVER trusts a user id sent by the client — it derives identity
 * from the verified token (plan §5).
 */
export async function requireUser(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const user = await getUserFromToken(token);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    req.user = user;
    req.accessToken = token;
    next();
  } catch (e) {
    res.status(401).json({ error: 'unauthorized', detail: String(e.message || e) });
  }
}
