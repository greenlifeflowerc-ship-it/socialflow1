import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({
  origin: process.env.CORS_ORIGIN === "*" || !process.env.CORS_ORIGIN
    ? true
    : process.env.CORS_ORIGIN.split(",").map((v) => v.trim()),
  credentials: true,
}));

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_BYTES || 250 * 1024 * 1024),
  },
});

function hasEnv(name) {
  return Boolean(process.env[name] && String(process.env[name]).trim().length > 0);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function graphVersion() {
  return process.env.META_GRAPH_VERSION || "v25.0";
}

function instagramScopes() {
  return (
    process.env.INSTAGRAM_SCOPES ||
    "instagram_business_basic,instagram_business_content_publish"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getSupabaseAdmin() {
  return createClient(
    requiredEnv("SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}

function configureCloudinary() {
  cloudinary.config({
    cloud_name: requiredEnv("CLOUDINARY_CLOUD_NAME"),
    api_key: requiredEnv("CLOUDINARY_API_KEY"),
    api_secret: requiredEnv("CLOUDINARY_API_SECRET"),
    secure: true,
  });
}

function encryptionKey() {
  const raw = requiredEnv("TOKEN_ENCRYPTION_KEY");
  if (raw.length < 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be at least 32 characters.");
  }
  return crypto.createHash("sha256").update(raw).digest();
}

function encryptText(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plainText), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
}

function decryptText(encryptedText) {
  const parts = String(encryptedText).split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Invalid encrypted text format.");
  }

  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  const encrypted = Buffer.from(parts[3], "base64url");

  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
}

function cleanErrorMessage(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (error.message) return error.message;
  return JSON.stringify(error);
}

function htmlPage(title, bodyHtml) {
  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
      </head>
      <body style="font-family: Arial, sans-serif; max-width: 850px; margin: 40px auto; padding: 0 20px; line-height: 1.6;">
        ${bodyHtml}
      </body>
    </html>
  `;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number(process.env.FETCH_TIMEOUT_MS || 60000)
  );

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    const text = await response.text();
    let json = null;

    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    if (!response.ok) {
      const message =
        json?.error?.message ||
        json?.message ||
        text ||
        `HTTP ${response.status}`;

      const error = new Error(message);
      error.status = response.status;
      error.response = json;
      throw error;
    }

    return json;
  } finally {
    clearTimeout(timeout);
  }
}

async function requireUser(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;

    if (!token) {
      if (
        process.env.ALLOW_DEV_NO_AUTH === "true" &&
        process.env.DEV_USER_ID
      ) {
        req.user = {
          id: process.env.DEV_USER_ID,
          email: "dev-user@local.test",
          dev: true,
        };
        return next();
      }

      return res.status(401).json({
        ok: false,
        error: "Missing Authorization Bearer token.",
      });
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user?.id) {
      return res.status(401).json({
        ok: false,
        error: "Invalid or expired user token.",
      });
    }

    req.user = {
      id: data.user.id,
      email: data.user.email,
    };

    return next();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
    });
  }
}

function requireCron(req, res, next) {
  const expected = process.env.CRON_SECRET;
  const actual = req.headers["x-cron-secret"];

  if (!expected || actual !== expected) {
    return res.status(401).json({
      ok: false,
      error: "Invalid cron secret.",
    });
  }

  return next();
}

async function getAccountForUser({ userId, accountId, includeToken = false }) {
  const supabase = getSupabaseAdmin();

  const columns = includeToken
    ? "*"
    : "id,user_id,platform,ig_user_id,username,account_type,status,created_at,updated_at";

  const { data, error } = await supabase
    .from("social_accounts")
    .select(columns)
    .eq("id", accountId)
    .eq("user_id", userId)
    .eq("platform", "instagram")
    .neq("status", "disconnected")
    .single();

  if (error || !data) {
    throw new Error("Instagram account not found for this user.");
  }

  return data;
}

async function addPublishLog({ userId, postId = null, socialAccountId = null, action, status, message = null, meta = null }) {
  try {
    const supabase = getSupabaseAdmin();
    await supabase.from("publish_logs").insert({
      user_id: userId,
      post_id: postId,
      social_account_id: socialAccountId,
      action,
      status,
      message,
      meta,
    });
  } catch (error) {
    console.error("Failed to write publish log:", cleanErrorMessage(error));
  }
}

async function uploadBufferToCloudinary({ buffer, mimetype, originalname, userId }) {
  configureCloudinary();

  const assetId = crypto.randomUUID();
  const folder = `socialflow/${userId}`;
  const resourceType = mimetype?.startsWith("video/") ? "video" : "image";

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        public_id: assetId,
        resource_type: resourceType,
        overwrite: false,
      },
      (error, result) => {
        if (error) return reject(error);
        return resolve({
          result,
          assetId,
          resourceType,
          originalname,
        });
      }
    );

    stream.end(buffer);
  });
}

async function createInstagramContainer({ account, token, post }) {
  const baseUrl = `https://graph.instagram.com/${graphVersion()}/${account.ig_user_id}/media`;

  const params = new URLSearchParams();
  params.set("caption", post.caption || "");
  params.set("access_token", token);

  if (post.media_type === "image") {
    params.set("image_url", post.media_url);
  } else if (post.media_type === "video") {
    params.set("video_url", post.media_url);
    params.set("media_type", "VIDEO");
  } else if (post.media_type === "reels") {
    params.set("video_url", post.media_url);
    params.set("media_type", "REELS");
  } else {
    throw new Error(`Unsupported media_type: ${post.media_type}`);
  }

  return fetchJson(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
}

async function waitForContainerReady({ containerId, token }) {
  const maxChecks = Number(process.env.IG_CONTAINER_MAX_CHECKS || 20);
  const delayMs = Number(process.env.IG_CONTAINER_CHECK_DELAY_MS || 3000);

  for (let i = 0; i < maxChecks; i += 1) {
    const url = new URL(`https://graph.instagram.com/${graphVersion()}/${containerId}`);
    url.searchParams.set("fields", "id,status_code,status");
    url.searchParams.set("access_token", token);

    const data = await fetchJson(url.toString());

    if (data.status_code === "FINISHED") {
      return data;
    }

    if (data.status_code === "ERROR" || data.status_code === "EXPIRED") {
      throw new Error(`Instagram container failed: ${data.status || data.status_code}`);
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error("Instagram media container is not ready yet. Try again later.");
}

async function publishInstagramContainer({ account, token, containerId }) {
  const url = `https://graph.instagram.com/${graphVersion()}/${account.ig_user_id}/media_publish`;

  const params = new URLSearchParams();
  params.set("creation_id", containerId);
  params.set("access_token", token);

  return fetchJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
}

async function fetchPublishedMedia({ mediaId, token }) {
  const url = new URL(`https://graph.instagram.com/${graphVersion()}/${mediaId}`);
  url.searchParams.set("fields", "id,permalink,media_type,media_url,timestamp,caption");
  url.searchParams.set("access_token", token);

  return fetchJson(url.toString());
}

async function publishPostById({ postId, userId = null }) {
  const supabase = getSupabaseAdmin();

  let query = supabase
    .from("scheduled_posts")
    .select("*")
    .eq("id", postId)
    .single();

  if (userId) query = query.eq("user_id", userId);

  const { data: currentPost, error: readError } = await query;

  if (readError || !currentPost) {
    throw new Error("Post not found.");
  }

  if (currentPost.status === "published") {
    return {
      ok: true,
      alreadyPublished: true,
      post: currentPost,
    };
  }

  if (currentPost.status === "publishing") {
    throw new Error("Post is already publishing.");
  }

  if (currentPost.attempts >= currentPost.max_attempts) {
    throw new Error("Post reached max attempts.");
  }

  const { data: lockedPost, error: lockError } = await supabase
    .from("scheduled_posts")
    .update({
      status: "publishing",
      attempts: currentPost.attempts + 1,
      error_message: null,
    })
    .eq("id", postId)
    .in("status", ["draft", "scheduled", "failed"])
    .select("*")
    .single();

  if (lockError || !lockedPost) {
    throw new Error("Could not lock post for publishing.");
  }

  const account = await getAccountForUser({
    userId: lockedPost.user_id,
    accountId: lockedPost.social_account_id,
    includeToken: true,
  });

  const token = decryptText(account.encrypted_access_token);

  try {
    await addPublishLog({
      userId: lockedPost.user_id,
      postId: lockedPost.id,
      socialAccountId: account.id,
      action: "publish_start",
      status: "started",
      message: "Publishing started.",
    });

    const container = await createInstagramContainer({
      account,
      token,
      post: lockedPost,
    });

    const containerId = container.id;
    if (!containerId) {
      throw new Error("Instagram did not return a media container id.");
    }

    await supabase
      .from("scheduled_posts")
      .update({ instagram_container_id: containerId })
      .eq("id", lockedPost.id);

    await waitForContainerReady({ containerId, token });

    const published = await publishInstagramContainer({
      account,
      token,
      containerId,
    });

    const mediaId = published.id;
    if (!mediaId) {
      throw new Error("Instagram did not return published media id.");
    }

    let mediaInfo = null;
    try {
      mediaInfo = await fetchPublishedMedia({ mediaId, token });
    } catch (error) {
      mediaInfo = null;
    }

    const { data: updatedPost, error: updateError } = await supabase
      .from("scheduled_posts")
      .update({
        status: "published",
        published_media_id: mediaId,
        published_permalink: mediaInfo?.permalink || null,
        published_at: new Date().toISOString(),
        error_message: null,
      })
      .eq("id", lockedPost.id)
      .select("*")
      .single();

    if (updateError) {
      throw new Error(updateError.message);
    }

    await addPublishLog({
      userId: lockedPost.user_id,
      postId: lockedPost.id,
      socialAccountId: account.id,
      action: "publish_success",
      status: "success",
      message: "Post published successfully.",
      meta: {
        mediaId,
        permalink: mediaInfo?.permalink || null,
      },
    });

    return {
      ok: true,
      post: updatedPost,
    };
  } catch (error) {
    const message = cleanErrorMessage(error);

    await supabase
      .from("scheduled_posts")
      .update({
        status: "failed",
        error_message: message,
      })
      .eq("id", lockedPost.id);

    await addPublishLog({
      userId: lockedPost.user_id,
      postId: lockedPost.id,
      socialAccountId: account.id,
      action: "publish_failed",
      status: "failed",
      message,
      meta: error.response || null,
    });

    throw error;
  }
}

/* Public routes */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "socialflow-api",
    message: "SocialFlow API is running.",
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "socialflow-api",
    time: new Date().toISOString(),
    env: process.env.NODE_ENV || "development",
  });
});

app.get("/api/config/status", (req, res) => {
  res.json({
    ok: true,

    instagramConfigured:
      hasEnv("INSTAGRAM_APP_ID") &&
      hasEnv("INSTAGRAM_APP_SECRET") &&
      hasEnv("INSTAGRAM_REDIRECT_URI") &&
      hasEnv("META_GRAPH_VERSION"),

    supabaseConfigured:
      hasEnv("SUPABASE_URL") &&
      hasEnv("SUPABASE_SERVICE_ROLE_KEY"),

    cloudinaryConfigured:
      hasEnv("CLOUDINARY_CLOUD_NAME") &&
      hasEnv("CLOUDINARY_API_KEY") &&
      hasEnv("CLOUDINARY_API_SECRET"),

    tokenEncryptionConfigured:
      hasEnv("TOKEN_ENCRYPTION_KEY") &&
      process.env.TOKEN_ENCRYPTION_KEY.length >= 32,

    cronConfigured: hasEnv("CRON_SECRET"),

    devNoAuthEnabled: process.env.ALLOW_DEV_NO_AUTH === "true",
  });
});

app.get("/privacy", (req, res) => {
  res.send(htmlPage(
    "Privacy Policy - SocialFlow",
    `
      <h1>Privacy Policy</h1>
      <p>SocialFlow lets users connect their Instagram professional accounts only after authorization.</p>
      <p>We store connected Instagram account data, scheduled posts, uploaded media URLs, captions, publishing status, logs, comments, messages, and insights only as needed to provide the service.</p>
      <p>Each customer account is stored separately and linked to that customer's authenticated user ID.</p>
      <p>Access tokens are encrypted on the backend. We do not expose tokens or server secrets to the mobile app.</p>
      <p>Users can request deletion of their account data through the data deletion page.</p>
    `
  ));
});

app.get("/terms", (req, res) => {
  res.send(htmlPage(
    "Terms of Service - SocialFlow",
    `
      <h1>Terms of Service</h1>
      <p>Users are responsible for all content they upload, schedule, publish, or send through SocialFlow.</p>
      <p>Users must only publish content they own or have permission to use.</p>
      <p>Users must comply with Instagram, Meta, and applicable laws and policies.</p>
      <p>SocialFlow depends on third-party APIs. Publishing, comments, messages, and insights can fail if third-party APIs reject or limit requests.</p>
    `
  ));
});

app.get("/data-deletion", (req, res) => {
  res.send(htmlPage(
    "Data Deletion - SocialFlow",
    `
      <h1>User Data Deletion</h1>
      <p>Users can request deletion of their account data, connected Instagram account data, scheduled posts, media URLs, publishing logs, comments, messages, and insights data.</p>
      <p>To request deletion, contact the app owner using the email associated with your account.</p>
      <p>After verification, we will delete related data unless retention is required for legal, security, or fraud-prevention reasons.</p>
    `
  ));
});

/* Instagram OAuth */

app.get("/api/auth/instagram/start", requireUser, async (req, res) => {
  try {
    const appId = requiredEnv("INSTAGRAM_APP_ID");
    const redirectUri = requiredEnv("INSTAGRAM_REDIRECT_URI");
    const supabase = getSupabaseAdmin();

    const state = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { error } = await supabase.from("oauth_states").insert({
      state,
      user_id: req.user.id,
      expires_at: expiresAt,
    });

    if (error) {
      throw new Error(error.message);
    }

    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: instagramScopes().join(","),
      state,
    });

    const authUrl = `https://www.instagram.com/oauth/authorize?${params.toString()}`;

    return res.json({
      ok: true,
      authUrl,
      state,
      scopes: instagramScopes(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
    });
  }
});

app.get("/api/auth/instagram/callback", async (req, res) => {
  const {
    code,
    state,
    error,
    error_reason,
    error_description,
  } = req.query;

  try {
    if (error) {
      return res.status(400).send(htmlPage(
        "Instagram Connection Failed",
        `
          <h1>Instagram connection failed</h1>
          <p><b>Error:</b> ${String(error)}</p>
          <p><b>Reason:</b> ${String(error_reason || "")}</p>
          <p><b>Description:</b> ${String(error_description || "")}</p>
        `
      ));
    }

    if (!code || !state) {
      return res.status(400).send(htmlPage(
        "Instagram Connection Failed",
        `<h1>Missing code or state.</h1>`
      ));
    }

    const supabase = getSupabaseAdmin();

    const { data: oauthState, error: stateError } = await supabase
      .from("oauth_states")
      .select("*")
      .eq("state", String(state))
      .is("used_at", null)
      .gt("expires_at", new Date().toISOString())
      .single();

    if (stateError || !oauthState) {
      return res.status(400).send(htmlPage(
        "Instagram Connection Failed",
        `<h1>Invalid or expired OAuth state.</h1>`
      ));
    }

    const tokenParams = new URLSearchParams();
    tokenParams.set("client_id", requiredEnv("INSTAGRAM_APP_ID"));
    tokenParams.set("client_secret", requiredEnv("INSTAGRAM_APP_SECRET"));
    tokenParams.set("grant_type", "authorization_code");
    tokenParams.set("redirect_uri", requiredEnv("INSTAGRAM_REDIRECT_URI"));
    tokenParams.set("code", String(code));

    const shortToken = await fetchJson("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: tokenParams,
    });

    if (!shortToken?.access_token) {
      throw new Error("Instagram did not return a short-lived access token.");
    }

    const longUrl = new URL("https://graph.instagram.com/access_token");
    longUrl.searchParams.set("grant_type", "ig_exchange_token");
    longUrl.searchParams.set("client_secret", requiredEnv("INSTAGRAM_APP_SECRET"));
    longUrl.searchParams.set("access_token", shortToken.access_token);

    const longToken = await fetchJson(longUrl.toString());

    const accessToken = longToken?.access_token || shortToken.access_token;
    const expiresIn = longToken?.expires_in || null;

    const profileUrl = new URL(`https://graph.instagram.com/${graphVersion()}/me`);
    profileUrl.searchParams.set("fields", "user_id,username,account_type,media_count");
    profileUrl.searchParams.set("access_token", accessToken);

    const profile = await fetchJson(profileUrl.toString());

    const igUserId = String(profile.user_id || profile.id || shortToken.user_id || "");
    if (!igUserId) {
      throw new Error("Could not determine Instagram user id.");
    }

    const tokenExpiresAt = expiresIn
      ? new Date(Date.now() + Number(expiresIn) * 1000).toISOString()
      : null;

    const encryptedToken = encryptText(accessToken);

    const { data: savedAccount, error: upsertError } = await supabase
      .from("social_accounts")
      .upsert(
        {
          user_id: oauthState.user_id,
          platform: "instagram",
          ig_user_id: igUserId,
          username: profile.username || null,
          account_type: profile.account_type || null,
          encrypted_access_token: encryptedToken,
          token_expires_at: tokenExpiresAt,
          scopes: instagramScopes(),
          status: "connected",
        },
        {
          onConflict: "user_id,platform,ig_user_id",
        }
      )
      .select("id,username,ig_user_id,account_type,status")
      .single();

    if (upsertError) {
      throw new Error(upsertError.message);
    }

    await supabase
      .from("oauth_states")
      .update({ used_at: new Date().toISOString() })
      .eq("state", String(state));

    const successUrl = process.env.FRONTEND_SUCCESS_URL;

    return res.send(htmlPage(
      "Instagram Connected",
      `
        <h1>Instagram connected successfully.</h1>
        <p>Connected account: <b>${savedAccount.username || igUserId}</b></p>
        <p>You can close this window and return to the app.</p>
        ${successUrl ? `<p><a href="${successUrl}">Return to app</a></p>` : ""}
      `
    ));
  } catch (err) {
    console.error("Instagram callback error:", cleanErrorMessage(err));

    const errorUrl = process.env.FRONTEND_ERROR_URL;

    return res.status(500).send(htmlPage(
      "Instagram Connection Failed",
      `
        <h1>Instagram connection failed</h1>
        <p>${cleanErrorMessage(err)}</p>
        ${errorUrl ? `<p><a href="${errorUrl}">Return to app</a></p>` : ""}
      `
    ));
  }
});

/* Accounts */

app.get("/api/accounts", requireUser, async (req, res) => {
  try {
    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
      .from("social_accounts")
      .select("id,platform,ig_user_id,username,account_type,status,created_at,updated_at")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);

    return res.json({
      ok: true,
      accounts: data || [],
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
    });
  }
});

app.delete("/api/accounts/:id", requireUser, async (req, res) => {
  try {
    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
      .from("social_accounts")
      .update({ status: "disconnected" })
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .select("id,platform,username,status")
      .single();

    if (error) throw new Error(error.message);

    return res.json({
      ok: true,
      account: data,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
    });
  }
});

/* Media */

app.post("/api/media/upload", requireUser, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "Missing file.",
      });
    }

    const allowed =
      req.file.mimetype.startsWith("image/") ||
      req.file.mimetype.startsWith("video/");

    if (!allowed) {
      return res.status(400).json({
        ok: false,
        error: "Only image and video files are allowed.",
      });
    }

    const uploaded = await uploadBufferToCloudinary({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      originalname: req.file.originalname,
      userId: req.user.id,
    });

    const r = uploaded.result;
    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
      .from("media_assets")
      .insert({
        user_id: req.user.id,
        cloudinary_public_id: r.public_id,
        media_url: r.secure_url,
        secure_url: r.secure_url,
        resource_type: r.resource_type,
        original_filename: req.file.originalname,
        bytes: r.bytes || null,
        format: r.format || null,
      })
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    return res.json({
      ok: true,
      asset: data,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
    });
  }
});

/* Posts */

app.get("/api/posts", requireUser, async (req, res) => {
  try {
    const supabase = getSupabaseAdmin();

    let query = supabase
      .from("scheduled_posts")
      .select(`
        id,
        social_account_id,
        media_asset_id,
        caption,
        media_url,
        media_type,
        scheduled_at,
        timezone,
        status,
        attempts,
        max_attempts,
        instagram_container_id,
        published_media_id,
        published_permalink,
        published_at,
        error_message,
        created_at,
        updated_at,
        social_accounts (
          id,
          username,
          ig_user_id,
          account_type,
          status
        )
      `)
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (req.query.status) {
      query = query.eq("status", String(req.query.status));
    }

    const { data, error } = await query;

    if (error) throw new Error(error.message);

    return res.json({
      ok: true,
      posts: data || [],
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
    });
  }
});

app.post("/api/posts/schedule", requireUser, async (req, res) => {
  try {
    const {
      social_account_id,
      media_asset_id,
      caption,
      scheduled_at,
      timezone,
      media_type,
    } = req.body;

    if (!social_account_id) {
      return res.status(400).json({
        ok: false,
        error: "social_account_id is required.",
      });
    }

    if (!media_asset_id) {
      return res.status(400).json({
        ok: false,
        error: "media_asset_id is required.",
      });
    }

    if (!scheduled_at) {
      return res.status(400).json({
        ok: false,
        error: "scheduled_at is required.",
      });
    }

    const account = await getAccountForUser({
      userId: req.user.id,
      accountId: social_account_id,
      includeToken: false,
    });

    const supabase = getSupabaseAdmin();

    const { data: asset, error: assetError } = await supabase
      .from("media_assets")
      .select("*")
      .eq("id", media_asset_id)
      .eq("user_id", req.user.id)
      .single();

    if (assetError || !asset) {
      throw new Error("Media asset not found for this user.");
    }

    const detectedMediaType =
      media_type ||
      (asset.resource_type === "video" ? "video" : "image");

    const { data, error } = await supabase
      .from("scheduled_posts")
      .insert({
        user_id: req.user.id,
        social_account_id: account.id,
        media_asset_id: asset.id,
        caption: caption || "",
        media_url: asset.secure_url,
        media_type: detectedMediaType,
        scheduled_at,
        timezone: timezone || "Asia/Dubai",
        status: "scheduled",
      })
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    return res.json({
      ok: true,
      post: data,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
    });
  }
});

app.post("/api/posts/publish-now", requireUser, async (req, res) => {
  try {
    const {
      post_id,
      social_account_id,
      media_asset_id,
      caption,
      media_type,
    } = req.body;

    let postId = post_id;

    const supabase = getSupabaseAdmin();

    if (!postId) {
      if (!social_account_id || !media_asset_id) {
        return res.status(400).json({
          ok: false,
          error: "Either post_id or social_account_id + media_asset_id are required.",
        });
      }

      const account = await getAccountForUser({
        userId: req.user.id,
        accountId: social_account_id,
        includeToken: false,
      });

      const { data: asset, error: assetError } = await supabase
        .from("media_assets")
        .select("*")
        .eq("id", media_asset_id)
        .eq("user_id", req.user.id)
        .single();

      if (assetError || !asset) {
        throw new Error("Media asset not found for this user.");
      }

      const detectedMediaType =
        media_type ||
        (asset.resource_type === "video" ? "video" : "image");

      const { data: created, error: createError } = await supabase
        .from("scheduled_posts")
        .insert({
          user_id: req.user.id,
          social_account_id: account.id,
          media_asset_id: asset.id,
          caption: caption || "",
          media_url: asset.secure_url,
          media_type: detectedMediaType,
          scheduled_at: null,
          timezone: "Asia/Dubai",
          status: "draft",
        })
        .select("*")
        .single();

      if (createError) throw new Error(createError.message);
      postId = created.id;
    }

    const result = await publishPostById({
      postId,
      userId: req.user.id,
    });

    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: error.response || null,
    });
  }
});

app.post("/api/posts/:id/retry", requireUser, async (req, res) => {
  try {
    const result = await publishPostById({
      postId: req.params.id,
      userId: req.user.id,
    });

    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: error.response || null,
    });
  }
});

app.post("/api/posts/:id/cancel", requireUser, async (req, res) => {
  try {
    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
      .from("scheduled_posts")
      .update({ status: "cancelled" })
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .in("status", ["draft", "scheduled", "failed"])
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    return res.json({
      ok: true,
      post: data,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
    });
  }
});

/* Cron */

app.post("/api/cron/publish-due", requireCron, async (req, res) => {
  try {
    const supabase = getSupabaseAdmin();

    const { data: posts, error } = await supabase
      .from("scheduled_posts")
      .select("id,user_id,scheduled_at,status,attempts,max_attempts")
      .eq("status", "scheduled")
      .lte("scheduled_at", new Date().toISOString())
      .lt("attempts", 3)
      .order("scheduled_at", { ascending: true })
      .limit(Number(process.env.CRON_BATCH_SIZE || 10));

    if (error) throw new Error(error.message);

    const results = [];

    for (const post of posts || []) {
      try {
        const result = await publishPostById({
          postId: post.id,
          userId: null,
        });

        results.push({
          post_id: post.id,
          ok: true,
          result,
        });
      } catch (err) {
        results.push({
          post_id: post.id,
          ok: false,
          error: cleanErrorMessage(err),
        });
      }
    }

    return res.json({
      ok: true,
      count: results.length,
      results,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
    });
  }
});

/* Insights */

app.get("/api/insights/account", requireUser, async (req, res) => {
  try {
    const accountId = req.query.account_id;
    if (!accountId) {
      return res.status(400).json({
        ok: false,
        error: "account_id is required.",
      });
    }

    const account = await getAccountForUser({
      userId: req.user.id,
      accountId,
      includeToken: true,
    });

    const token = decryptText(account.encrypted_access_token);

    const metrics = String(req.query.metrics || "views,reach,total_interactions")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .join(",");

    const period = String(req.query.period || "day");

    const url = new URL(`https://graph.instagram.com/${graphVersion()}/${account.ig_user_id}/insights`);
    url.searchParams.set("metric", metrics);
    url.searchParams.set("period", period);
    url.searchParams.set("access_token", token);

    const data = await fetchJson(url.toString());

    return res.json({
      ok: true,
      insights: data,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: error.response || null,
    });
  }
});

app.get("/api/posts/:id/insights", requireUser, async (req, res) => {
  try {
    const supabase = getSupabaseAdmin();

    const { data: post, error: postError } = await supabase
      .from("scheduled_posts")
      .select("*")
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .single();

    if (postError || !post) {
      throw new Error("Post not found.");
    }

    if (!post.published_media_id) {
      return res.status(400).json({
        ok: false,
        error: "Post is not published yet.",
      });
    }

    const account = await getAccountForUser({
      userId: req.user.id,
      accountId: post.social_account_id,
      includeToken: true,
    });

    const token = decryptText(account.encrypted_access_token);

    const metrics = String(req.query.metrics || "views,reach,total_interactions,likes,comments,shares,saved")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .join(",");

    const url = new URL(`https://graph.instagram.com/${graphVersion()}/${post.published_media_id}/insights`);
    url.searchParams.set("metric", metrics);
    url.searchParams.set("access_token", token);

    const data = await fetchJson(url.toString());

    return res.json({
      ok: true,
      insights: data,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: error.response || null,
    });
  }
});

/* Comments */

app.get("/api/posts/:id/comments", requireUser, async (req, res) => {
  try {
    const supabase = getSupabaseAdmin();

    const { data: post, error: postError } = await supabase
      .from("scheduled_posts")
      .select("*")
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .single();

    if (postError || !post) {
      throw new Error("Post not found.");
    }

    if (!post.published_media_id) {
      return res.status(400).json({
        ok: false,
        error: "Post is not published yet.",
      });
    }

    const account = await getAccountForUser({
      userId: req.user.id,
      accountId: post.social_account_id,
      includeToken: true,
    });

    const token = decryptText(account.encrypted_access_token);

    const url = new URL(`https://graph.instagram.com/${graphVersion()}/${post.published_media_id}/comments`);
    url.searchParams.set("fields", "id,text,username,timestamp,like_count,replies{id,text,username,timestamp}");
    url.searchParams.set("access_token", token);

    const data = await fetchJson(url.toString());

    return res.json({
      ok: true,
      comments: data,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: error.response || null,
    });
  }
});

app.post("/api/posts/:id/comments/:commentId/reply", requireUser, async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || !String(message).trim()) {
      return res.status(400).json({
        ok: false,
        error: "message is required.",
      });
    }

    const supabase = getSupabaseAdmin();

    const { data: post, error: postError } = await supabase
      .from("scheduled_posts")
      .select("*")
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .single();

    if (postError || !post) {
      throw new Error("Post not found.");
    }

    const account = await getAccountForUser({
      userId: req.user.id,
      accountId: post.social_account_id,
      includeToken: true,
    });

    const token = decryptText(account.encrypted_access_token);

    const url = `https://graph.instagram.com/${graphVersion()}/${req.params.commentId}/replies`;

    const params = new URLSearchParams();
    params.set("message", String(message));
    params.set("access_token", token);

    const data = await fetchJson(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });

    return res.json({
      ok: true,
      reply: data,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: error.response || null,
    });
  }
});

/* Messaging proxy */

app.get("/api/messages/conversations", requireUser, async (req, res) => {
  try {
    const accountId = req.query.account_id;
    if (!accountId) {
      return res.status(400).json({
        ok: false,
        error: "account_id is required.",
      });
    }

    const account = await getAccountForUser({
      userId: req.user.id,
      accountId,
      includeToken: true,
    });

    const token = decryptText(account.encrypted_access_token);

    const url = new URL(`https://graph.instagram.com/${graphVersion()}/${account.ig_user_id}/conversations`);
    url.searchParams.set("fields", "id,participants,updated_time,messages.limit(20){id,from,to,message,created_time}");
    url.searchParams.set("platform", "instagram");
    url.searchParams.set("access_token", token);

    const data = await fetchJson(url.toString());

    return res.json({
      ok: true,
      conversations: data,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: error.response || null,
    });
  }
});

app.post("/api/messages/send", requireUser, async (req, res) => {
  try {
    const { account_id, recipient_id, message } = req.body;

    if (!account_id || !recipient_id || !message) {
      return res.status(400).json({
        ok: false,
        error: "account_id, recipient_id, and message are required.",
      });
    }

    const account = await getAccountForUser({
      userId: req.user.id,
      accountId: account_id,
      includeToken: true,
    });

    const token = decryptText(account.encrypted_access_token);

    const url = `https://graph.instagram.com/${graphVersion()}/${account.ig_user_id}/messages`;

    const body = {
      recipient: { id: String(recipient_id) },
      message: { text: String(message) },
    };

    const data = await fetchJson(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    return res.json({
      ok: true,
      sent: data,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: error.response || null,
    });
  }
});

/* Logs */

app.get("/api/logs", requireUser, async (req, res) => {
  try {
    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
      .from("publish_logs")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(Number(req.query.limit || 100));

    if (error) throw new Error(error.message);

    return res.json({
      ok: true,
      logs: data || [],
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
    });
  }
});

/* Not found and error handlers */

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Route not found.",
    path: req.path,
  });
});

app.use((err, req, res, next) => {
  console.error("Unhandled server error:", cleanErrorMessage(err));
  res.status(500).json({
    ok: false,
    error: "Internal server error.",
  });
});

app.listen(PORT, () => {
  console.log(`SocialFlow API running on port ${PORT}`);
});
