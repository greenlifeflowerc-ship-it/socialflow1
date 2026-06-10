# Schudlaaa server

OAuth + Cloudinary signing + publishing scheduler for the Schudlaaa social media
scheduler. Node/Express, deployed on Render.

- `src/index.js` — Express app + routes, starts the scheduler
- `src/oauth/*` — per-platform OAuth (Facebook/Instagram, Pinterest, X, TikTok)
- `src/publishers/*` — per-platform publishing (real + mock fallback)
- `src/scheduler.js` — node-cron loop that publishes due posts
- `render.yaml` — Render Blueprint

## Run locally
```bash
cp .env.example .env   # fill in keys
npm install
npm start              # http://localhost:8080
```

Configuration is documented in `.env.example`. Secrets live only in `.env`
(gitignored) or the Render dashboard — never committed.
