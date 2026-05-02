import express from "express";
import cors from "cors";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;

function hasEnv(name) {
  return Boolean(process.env[name] && String(process.env[name]).trim().length > 0);
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "autoflow-api",
    time: new Date().toISOString(),
    env: process.env.NODE_ENV || "development",
  });
});

app.get("/api/config/status", (req, res) => {
  res.json({
    ok: true,
    metaConfigured:
      hasEnv("META_APP_ID") &&
      hasEnv("META_APP_SECRET") &&
      hasEnv("META_REDIRECT_URI") &&
      hasEnv("META_GRAPH_VERSION"),

    supabaseConfigured:
      hasEnv("SUPABASE_URL") &&
      hasEnv("SUPABASE_SERVICE_ROLE_KEY"),

    cloudinaryConfigured:
      hasEnv("CLOUDINARY_CLOUD_NAME") &&
      hasEnv("CLOUDINARY_API_KEY") &&
      hasEnv("CLOUDINARY_API_SECRET"),

    aiConfigured:
      hasEnv("GEMINI_API_KEY") || hasEnv("OPENAI_API_KEY"),

    cronConfigured: hasEnv("CRON_SECRET"),

    tokenEncryptionConfigured:
      hasEnv("TOKEN_ENCRYPTION_KEY") &&
      process.env.TOKEN_ENCRYPTION_KEY.length >= 32,
  });
});

app.get("/api/auth/instagram/start", (req, res) => {
  const appId = process.env.META_APP_ID;
  const redirectUri = process.env.META_REDIRECT_URI;
  const graphVersion = process.env.META_GRAPH_VERSION || "v25.0";

  if (!appId || !redirectUri) {
    return res.status(500).json({
      ok: false,
      error: "Meta OAuth is not configured. Missing META_APP_ID or META_REDIRECT_URI.",
    });
  }

  const state = crypto.randomBytes(24).toString("hex");

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "instagram_business_basic,instagram_business_content_publish",
    state,
  });

  const authUrl = `https://www.instagram.com/oauth/authorize?${params.toString()}`;

  res.json({
    ok: true,
    authUrl,
    state,
    graphVersion,
  });
});

app.get("/api/auth/instagram/callback", async (req, res) => {
  const { code, state, error, error_reason, error_description } = req.query;

  if (error) {
    return res.status(400).send(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Instagram Connection Failed</title>
        </head>
        <body style="font-family: Arial; padding: 32px;">
          <h2>Instagram connection failed</h2>
          <p><b>Error:</b> ${String(error)}</p>
          <p><b>Reason:</b> ${String(error_reason || "")}</p>
          <p><b>Description:</b> ${String(error_description || "")}</p>
        </body>
      </html>
    `);
  }

  if (!code) {
    return res.status(400).send(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Missing Code</title>
        </head>
        <body style="font-family: Arial; padding: 32px;">
          <h2>Instagram callback received, but code is missing.</h2>
        </body>
      </html>
    `);
  }

  console.log("Instagram callback received:", {
    hasCode: true,
    hasState: Boolean(state),
    time: new Date().toISOString(),
  });

  return res.send(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Instagram Connected</title>
      </head>
      <body style="font-family: Arial; padding: 32px;">
        <h2>Instagram callback received successfully.</h2>
        <p>The server is ready for the next step: token exchange and account storage.</p>
        <p>You can close this window.</p>
      </body>
    </html>
  `);
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Route not found",
    path: req.path,
  });
});

app.use((err, req, res, next) => {
  console.error("Unhandled server error:", err);
  res.status(500).json({
    ok: false,
    error: "Internal server error",
  });
});

app.listen(PORT, () => {
  console.log(`AutoFlow API running on port ${PORT}`);
});