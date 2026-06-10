import { Router } from 'express';

// Public info + legal pages. Meta App Review requires reachable Privacy,
// Terms, and Data Deletion URLs, so these are preserved on the backend.
export const pagesRouter = Router();

const APP = 'SocialFlow';
const shell = (title, body) => `<!doctype html>
<html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title></head>
<body style="font-family:Arial,sans-serif;max-width:850px;margin:40px auto;padding:0 20px;line-height:1.6;color:#1a1b25;">
${body}
</body></html>`;

pagesRouter.get('/', (_req, res) => {
  res.type('html').send(shell(APP, `
    <h1>${APP}</h1>
    <p>${APP} is a social media management and scheduling platform for professional accounts.</p>
    <p>Users can connect their accounts (Facebook Pages, Instagram professional, Pinterest, TikTok, X),
       upload media, schedule and publish posts, and review their queue from one dashboard.</p>
    <h2>Reviewer information</h2>
    <p>This URL is the official backend and web information page for the ${APP} application.
       The app uses this server for OAuth, publishing, media upload, and scheduling.</p>
    <ul>
      <li><a href="/privacy">Privacy Policy</a></li>
      <li><a href="/terms">Terms of Service</a></li>
      <li><a href="/data-deletion">Data Deletion Instructions</a></li>
      <li><a href="/api/health">API Health Check</a></li>
    </ul>
    <p>Platform Data is only used to provide app functionality to the authenticated user who connected
       their own account. Platform Data is not sold and is not used for third-party advertising.</p>`));
});

pagesRouter.get('/privacy', (_req, res) => {
  res.type('html').send(shell(`${APP} — Privacy Policy`, `
    <h1>Privacy Policy</h1>
    <p>${APP} ("we") helps users schedule and publish content to social platforms they connect.</p>
    <h2>What we store</h2>
    <ul>
      <li>Your account profile (email, name) for authentication.</li>
      <li>Access tokens for platforms you connect, stored <strong>encrypted</strong>. We never store your platform passwords.</li>
      <li>Media you upload and the posts you schedule.</li>
    </ul>
    <h2>How we use it</h2>
    <p>Solely to provide the app's functionality (publishing on your behalf at the times you schedule).
       Your data is private to your account, is not sold, and is not used for third-party advertising.</p>
    <h2>Deletion</h2>
    <p>You can disconnect any platform at any time, and request full deletion — see
       <a href="/data-deletion">Data Deletion Instructions</a>.</p>
    <p>Contact: greenlifeflowerc@gmail.com</p>`));
});

pagesRouter.get('/terms', (_req, res) => {
  res.type('html').send(shell(`${APP} — Terms of Service`, `
    <h1>Terms of Service</h1>
    <p>By using ${APP} you agree to use it only with accounts you own or are authorized to manage,
       and to comply with each connected platform's terms and API policies.</p>
    <p>The service is provided "as is". You are responsible for the content you publish.</p>
    <p>Contact: greenlifeflowerc@gmail.com</p>`));
});

pagesRouter.get('/data-deletion', (_req, res) => {
  res.type('html').send(shell(`${APP} — Data Deletion`, `
    <h1>Data Deletion Instructions</h1>
    <p>To delete your ${APP} data:</p>
    <ol>
      <li>In the app, go to <strong>Accounts</strong> and disconnect each platform (removes stored tokens), and
          delete your media and posts.</li>
      <li>Or email <strong>greenlifeflowerc@gmail.com</strong> from your account email requesting deletion;
          we will erase your profile, tokens, media records, and posts within 30 days.</li>
    </ol>`));
});

pagesRouter.get('/api/health', (_req, res) => res.json({ ok: true }));
