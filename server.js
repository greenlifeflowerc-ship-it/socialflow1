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

app.use(
  cors({
    origin:
      process.env.CORS_ORIGIN === "*" || !process.env.CORS_ORIGIN
        ? true
        : process.env.CORS_ORIGIN.split(",").map((v) => v.trim()),
    credentials: true,
  })
);

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
  return String(value).trim();
}

function graphVersion() {
  return process.env.META_GRAPH_VERSION || "v25.0";
}

function instagramScopes() {
  return (
    process.env.INSTAGRAM_SCOPES ||
    "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_insights,instagram_business_manage_messages"
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
  const parts = String(encryptedText || "").split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Invalid encrypted text format.");
  }

  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  const encrypted = Buffer.from(parts[3], "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function cleanErrorMessage(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (error.message) return error.message;
  return JSON.stringify(error);
}

function safeErrorDetails(error) {
  return {
    message: cleanErrorMessage(error),
    status: error?.status || null,
    metaErrorCode:
      error?.response?.error?.code ||
      error?.response?.error?.status ||
      null,
    metaErrorType: error?.response?.error?.type || null,
    metaErrorSubcode: error?.response?.error?.error_subcode || null,
    metaTraceId: error?.response?.error?.fbtrace_id || null,
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function htmlPage(title, bodyHtml) {
  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(title)}</title>
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
        json?.raw ||
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

async function fetchBuffer(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download file: HTTP ${response.status}`);
  }

  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mimetype: response.headers.get("content-type") || "image/jpeg",
  };
}

function normalizeSecureUrl(asset) {
  return asset?.secure_url || asset?.media_url || asset?.url || null;
}

/* Gemini AI helpers */

function getGeminiApiKey(req) {
  const bodyKey = req.body?.api_key || req.body?.apiKey;
  const headerKey = req.headers["x-gemini-api-key"];
  const envKey = process.env.GEMINI_API_KEY;

  return String(bodyKey || headerKey || envKey || "").trim();
}

function normalizeGeminiModel(model) {
  const value = String(model || "").trim();

  if (!value) {
    return "";
  }

  return value.startsWith("models/") ? value.slice("models/".length) : value;
}

function requireGeminiModel(req, res) {
  const model = normalizeGeminiModel(
    req.body?.model ||
      req.body?.text_model ||
      req.body?.image_model ||
      req.query?.model
  );

  if (!model) {
    res.status(400).json({
      ok: false,
      error: "model is required. Select a Gemini model from the app.",
    });
    return null;
  }

  return model;
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;

  if (!Array.isArray(parts)) return "";

  return parts
    .map((part) => part?.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractGeminiInlineImage(data) {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];

  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts)
      ? candidate.content.parts
      : [];

    for (const part of parts) {
      const inlineData = part?.inlineData || part?.inline_data;

      if (inlineData?.data) {
        return {
          buffer: Buffer.from(inlineData.data, "base64"),
          mimetype: inlineData.mimeType || inlineData.mime_type || "image/png",
        };
      }
    }
  }

  return null;
}

function missingGeminiKeyResponse(res) {
  return res.status(400).json({
    ok: false,
    error:
      "Gemini API key is missing. Add your key or configure GEMINI_API_KEY on the backend.",
  });
}

async function fetchGeminiModels(apiKey) {
  const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
  url.searchParams.set("key", apiKey);

  return fetchJson(url.toString());
}

async function generateGeminiText({ apiKey, model, prompt }) {
  const normalizedModel = normalizeGeminiModel(model);

  if (!normalizedModel) {
    throw new Error("model is required.");
  }

  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      normalizedModel
    )}:generateContent`
  );

  url.searchParams.set("key", apiKey);

  return fetchJson(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: String(prompt || ""),
            },
          ],
        },
      ],
    }),
  });
}

async function generateGeminiImage({ apiKey, model, prompt, imageBuffer, imageMimeType }) {
  const normalizedModel = normalizeGeminiModel(model);

  if (!normalizedModel) {
    throw new Error("model is required.");
  }

  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      normalizedModel
    )}:generateContent`
  );

  url.searchParams.set("key", apiKey);

  const parts = [
    {
      text: String(prompt || ""),
    },
  ];

  if (imageBuffer) {
    parts.push({
      inline_data: {
        mime_type: imageMimeType || "image/jpeg",
        data: imageBuffer.toString("base64"),
      },
    });
  }

  return fetchJson(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts,
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
      },
    }),
  });
}

function buildImageEditPrompt({
  prompt,
  aspectRatio,
  resolution,
  preserveProduct,
  preservePlanter,
}) {
  const lines = [];

  lines.push(String(prompt || "").trim());
  lines.push("Edit the provided image according to the instruction.");
  lines.push("Return the edited image as the main result.");

  if (aspectRatio) {
    lines.push(`Requested aspect ratio: ${aspectRatio}.`);
  }

  if (resolution) {
    lines.push(`Requested resolution: ${resolution}.`);
  }

  if (preserveProduct) {
    lines.push(
      "Preserve the main product exactly. Do not change the tree/product shape, leaves, trunk, color, density, size, or identity."
    );
  }

  if (preservePlanter) {
    lines.push(
      "Preserve the planter/pot exactly. Do not change the pot shape, stones, material, color, size, texture, or details."
    );
  }

  lines.push("Do not add text, logos, watermarks, labels, UI, or random objects.");
  lines.push("Make the output realistic, clean, and commercially usable.");

  return lines.filter(Boolean).join("\n");
}

async function requireUser(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;

    if (!token) {
      if (process.env.ALLOW_DEV_NO_AUTH === "true" && process.env.DEV_USER_ID) {
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
    : "id,user_id,platform,ig_user_id,username,account_type,status,token_type,token_expires_at,token_last_refreshed_at,token_refresh_error,created_at,updated_at";

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

async function getMediaAssetForUser({ userId, mediaAssetId }) {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("media_assets")
    .select("*")
    .eq("id", mediaAssetId)
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    throw new Error("Media asset not found for this user.");
  }

  return data;
}

async function addPublishLog({
  userId,
  postId = null,
  socialAccountId = null,
  action,
  status,
  message = null,
  meta = null,
}) {
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

async function uploadBufferToCloudinary({
  buffer,
  mimetype,
  originalname,
  userId,
  folderSuffix = "",
}) {
  configureCloudinary();

  const assetId = crypto.randomUUID();
  const folder = `socialflow/${userId}${folderSuffix ? `/${folderSuffix}` : ""}`;
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

async function saveMediaAssetFromBuffer({
  userId,
  buffer,
  mimetype,
  originalname,
  folderSuffix = "",
}) {
  const uploaded = await uploadBufferToCloudinary({
    buffer,
    mimetype,
    originalname,
    userId,
    folderSuffix,
  });

  const r = uploaded.result;
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("media_assets")
    .insert({
      user_id: userId,
      cloudinary_public_id: r.public_id,
      media_url: r.secure_url,
      secure_url: r.secure_url,
      resource_type: r.resource_type,
      original_filename: originalname,
      bytes: r.bytes || buffer.length || null,
      format: r.format || null,
    })
    .select("*")
    .single();

  if (error) throw new Error(error.message);

  return data;
}

/* Instagram OAuth helpers */

async function exchangeCodeForShortInstagramToken(code) {
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

  return shortToken;
}

async function exchangeShortTokenForLongInstagramToken(shortAccessToken) {
  const clientSecret = requiredEnv("INSTAGRAM_APP_SECRET");

  const getUrl = new URL("https://graph.instagram.com/access_token");
  getUrl.searchParams.set("grant_type", "ig_exchange_token");
  getUrl.searchParams.set("client_secret", clientSecret);
  getUrl.searchParams.set("access_token", shortAccessToken);

  try {
    const data = await fetchJson(getUrl.toString(), {
      method: "GET",
    });

    if (!data?.access_token) {
      throw new Error("Instagram long-lived token response did not include access_token.");
    }

    return {
      ok: true,
      method: "GET",
      token: data,
      warning: null,
    };
  } catch (getError) {
    const postParams = new URLSearchParams();
    postParams.set("grant_type", "ig_exchange_token");
    postParams.set("client_secret", clientSecret);
    postParams.set("access_token", shortAccessToken);

    try {
      const data = await fetchJson("https://graph.instagram.com/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: postParams,
      });

      if (!data?.access_token) {
        throw new Error("Instagram long-lived token POST response did not include access_token.");
      }

      return {
        ok: true,
        method: "POST",
        token: data,
        warning: {
          getFailed: safeErrorDetails(getError),
          fallbackUsed: "POST",
        },
      };
    } catch (postError) {
      return {
        ok: false,
        method: null,
        token: null,
        warning: {
          getFailed: safeErrorDetails(getError),
          postFailed: safeErrorDetails(postError),
          fallbackUsed: "short_lived_token",
        },
      };
    }
  }
}

async function refreshLongLivedInstagramToken(longLivedAccessToken) {
  const refreshUrl = new URL("https://graph.instagram.com/refresh_access_token");
  refreshUrl.searchParams.set("grant_type", "ig_refresh_token");
  refreshUrl.searchParams.set("access_token", longLivedAccessToken);

  const data = await fetchJson(refreshUrl.toString(), {
    method: "GET",
  });

  if (!data?.access_token) {
    throw new Error("Instagram refresh token response did not include access_token.");
  }

  return data;
}

function isPastDate(value) {
  return Boolean(value && new Date(value).getTime() <= Date.now());
}

function daysUntil(value) {
  if (!value) return null;
  return (new Date(value).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
}

function shouldRefreshInstagramToken(account, { force = false } = {}) {
  if (!account || account.token_type !== "long_lived") return false;
  if (force) return true;

  const daysLeft = daysUntil(account.token_expires_at);
  if (daysLeft === null) return false;

  if (daysLeft > Number(process.env.IG_TOKEN_REFRESH_DAYS_BEFORE_EXPIRY || 14)) {
    return false;
  }

  if (account.token_last_refreshed_at) {
    const lastRefreshMs = new Date(account.token_last_refreshed_at).getTime();
    const minAgeMs = 24 * 60 * 60 * 1000;

    if (Number.isFinite(lastRefreshMs) && Date.now() - lastRefreshMs < minAgeMs) {
      return false;
    }
  }

  return true;
}

async function getUsableInstagramToken({ account, forceRefresh = false }) {
  if (!account?.encrypted_access_token) {
    throw new Error("Instagram account token is missing. Reconnect the Instagram account.");
  }

  if (forceRefresh && account.token_type !== "long_lived") {
    throw new Error("Only long-lived Instagram tokens can be refreshed. Reconnect the account to create a long-lived token.");
  }

  const token = decryptText(account.encrypted_access_token);

  if (account.token_expires_at && isPastDate(account.token_expires_at)) {
    throw new Error("Instagram access token has expired. Reconnect the Instagram account.");
  }

  if (!shouldRefreshInstagramToken(account, { force: forceRefresh })) {
    return token;
  }

  const supabase = getSupabaseAdmin();

  try {
    const refreshed = await refreshLongLivedInstagramToken(token);
    const refreshedToken = refreshed.access_token;
    const expiresIn = Number(refreshed.expires_in || 60 * 24 * 60 * 60);
    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const encryptedToken = encryptText(refreshedToken);

    const { error } = await supabase
      .from("social_accounts")
      .update({
        encrypted_access_token: encryptedToken,
        token_expires_at: tokenExpiresAt,
        token_type: "long_lived",
        token_last_refreshed_at: new Date().toISOString(),
        token_refresh_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", account.id);

    if (error) {
      throw new Error(error.message);
    }

    return refreshedToken;
  } catch (error) {
    await supabase
      .from("social_accounts")
      .update({
        token_refresh_error: cleanErrorMessage(error),
        updated_at: new Date().toISOString(),
      })
      .eq("id", account.id);

    if (forceRefresh) {
      throw error;
    }

    return token;
  }
}

async function fetchInstagramProfile(accessToken, shortToken = null) {
  const attempts = [
    {
      label: "unversioned_basic_user_id_username",
      url: "https://graph.instagram.com/me",
      fields: "user_id,username",
    },
    {
      label: "unversioned_basic_id_username",
      url: "https://graph.instagram.com/me",
      fields: "id,username",
    },
    {
      label: "versioned_basic_user_id_username",
      url: `https://graph.instagram.com/${graphVersion()}/me`,
      fields: "user_id,username",
    },
    {
      label: "versioned_basic_id_username",
      url: `https://graph.instagram.com/${graphVersion()}/me`,
      fields: "id,username",
    },
    {
      label: "unversioned_extended",
      url: "https://graph.instagram.com/me",
      fields: "user_id,username,account_type,media_count",
    },
    {
      label: "versioned_extended",
      url: `https://graph.instagram.com/${graphVersion()}/me`,
      fields: "user_id,username,account_type,media_count",
    },
  ];

  const errors = [];

  for (const attempt of attempts) {
    try {
      const profileUrl = new URL(attempt.url);
      profileUrl.searchParams.set("fields", attempt.fields);
      profileUrl.searchParams.set("access_token", accessToken);

      const profile = await fetchJson(profileUrl.toString());
      const igUserId = String(profile.user_id || profile.id || shortToken?.user_id || "");

      if (!igUserId) {
        throw new Error(
          `Profile fetch succeeded but Instagram user id is missing. Attempt: ${attempt.label}`
        );
      }

      return {
        ok: true,
        profile,
        igUserId,
        attempt: attempt.label,
        errors,
        fallbackUsed: false,
      };
    } catch (error) {
      errors.push({
        attempt: attempt.label,
        error: safeErrorDetails(error),
      });
    }
  }

  const fallbackIgUserId = String(shortToken?.user_id || "");

  if (fallbackIgUserId) {
    return {
      ok: true,
      profile: {
        id: fallbackIgUserId,
        user_id: fallbackIgUserId,
        username: null,
        account_type: null,
        media_count: null,
      },
      igUserId: fallbackIgUserId,
      attempt: "fallback_short_token_user_id",
      errors,
      fallbackUsed: true,
    };
  }

  const finalError = new Error("Failed to fetch Instagram profile and no fallback user_id was available.");
  finalError.profileFetchAttempts = errors;
  throw finalError;
}

/* Instagram publishing helpers */

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
  let query = supabase.from("scheduled_posts").select("*").eq("id", postId).single();

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

  try {
    const token = await getUsableInstagramToken({ account });

    await addPublishLog({
      userId: lockedPost.user_id,
      postId: lockedPost.id,
      socialAccountId: account.id,
      action: "publish_start",
      status: "started",
      message: "Publishing started.",
    });

    const container = await createInstagramContainer({ account, token, post: lockedPost });
    const containerId = container.id;

    if (!containerId) {
      throw new Error("Instagram did not return a media container id.");
    }

    await supabase
      .from("scheduled_posts")
      .update({ instagram_container_id: containerId })
      .eq("id", lockedPost.id);

    await waitForContainerReady({ containerId, token });

    const published = await publishInstagramContainer({ account, token, containerId });
    const mediaId = published.id;

    if (!mediaId) {
      throw new Error("Instagram did not return published media id.");
    }

    let mediaInfo = null;
    try {
      mediaInfo = await fetchPublishedMedia({ mediaId, token });
    } catch {
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
      meta: safeErrorDetails(error),
    });

    throw error;
  }
}

/* Public routes */

app.get("/", (req, res) => {
  res.send(
    htmlPage(
      "SocialFlow",
      `
      <h1>SocialFlow</h1>
      <p>
        SocialFlow is a social media management and scheduling platform for Instagram professional accounts.
      </p>
      <p>
        Users can connect their Instagram professional account, upload media, schedule posts, publish content,
        manage comments and messages, and review insights from one dashboard.
      </p>

      <h2>Reviewer Information</h2>
      <p>
        This URL is the official backend and web information page for the SocialFlow application.
        The app uses this server for Instagram OAuth, publishing, media upload, comments, messages,
        insights, AI features, and data deletion pages.
      </p>

      <ul>
        <li><a href="/privacy">Privacy Policy</a></li>
        <li><a href="/terms">Terms of Service</a></li>
        <li><a href="/data-deletion">Data Deletion Instructions</a></li>
        <li><a href="/api/health">API Health Check</a></li>
      </ul>

      <p>
        Platform Data is only used to provide app functionality to the authenticated user who connected
        their own Instagram professional account. Platform Data is not sold and is not used for third-party advertising.
      </p>
      `
    )
  );
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
      hasEnv("SUPABASE_URL") && hasEnv("SUPABASE_SERVICE_ROLE_KEY"),
    cloudinaryConfigured:
      hasEnv("CLOUDINARY_CLOUD_NAME") &&
      hasEnv("CLOUDINARY_API_KEY") &&
      hasEnv("CLOUDINARY_API_SECRET"),
    tokenEncryptionConfigured:
      hasEnv("TOKEN_ENCRYPTION_KEY") &&
      process.env.TOKEN_ENCRYPTION_KEY.length >= 32,
    cronConfigured: hasEnv("CRON_SECRET"),
    geminiConfigured: hasEnv("GEMINI_API_KEY"),
    devNoAuthEnabled: process.env.ALLOW_DEV_NO_AUTH === "true",
  });
});

app.get("/privacy", (req, res) => {
  res.send(
    htmlPage(
      "Privacy Policy - SocialFlow",
      `
      <h1>Privacy Policy</h1>
      <p>SocialFlow lets users connect their Instagram professional accounts only after authorization.</p>
      <p>We store connected Instagram account data, scheduled posts, uploaded media URLs, captions, publishing status, logs, comments, messages, insights, generated media, and edit history only as needed to provide the service.</p>
      <p>Each customer account is stored separately and linked to that customer's authenticated user ID.</p>
      <p>Access tokens are encrypted on the backend. We do not expose tokens or server secrets to the mobile app.</p>
      <p>Users can request deletion of their account data through the data deletion page.</p>
    `
    )
  );
});

app.get("/terms", (req, res) => {
  res.send(
    htmlPage(
      "Terms of Service - SocialFlow",
      `
      <h1>Terms of Service</h1>
      <p>Users are responsible for all content they upload, generate, edit, schedule, publish, or send through SocialFlow.</p>
      <p>Users must only publish content they own or have permission to use.</p>
      <p>Users must comply with Instagram, Meta, Gemini, Cloudinary, and applicable laws and policies.</p>
      <p>SocialFlow depends on third-party APIs. Publishing, comments, messages, AI generation, and insights can fail if third-party APIs reject or limit requests.</p>
    `
    )
  );
});

app.get("/data-deletion", (req, res) => {
  res.send(
    htmlPage(
      "Data Deletion - SocialFlow",
      `
      <h1>User Data Deletion</h1>
      <p>Users can request deletion of their account data, connected Instagram account data, scheduled posts, media URLs, generated media, publishing logs, comments, messages, and insights data.</p>
      <p>To request deletion, contact the app owner using the email associated with your account.</p>
      <p>After verification, we will delete related data unless retention is required for legal, security, or fraud-prevention reasons.</p>
    `
    )
  );
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
  const { code, state, error, error_reason, error_description } = req.query;
  let callbackStep = "received_callback";

  try {
    if (error) {
      return res.status(400).send(
        htmlPage(
          "Instagram Connection Failed",
          `
          <h1>Instagram connection failed</h1>
          <p><b>Error:</b> ${escapeHtml(error)}</p>
          <p><b>Reason:</b> ${escapeHtml(error_reason || "")}</p>
          <p><b>Description:</b> ${escapeHtml(error_description || "")}</p>
        `
        )
      );
    }

    if (!code || !state) {
      return res.status(400).send(
        htmlPage("Instagram Connection Failed", `<h1>Missing code or state.</h1>`)
      );
    }

    const supabase = getSupabaseAdmin();
    callbackStep = "state_validation";

    const { data: oauthState, error: stateError } = await supabase
      .from("oauth_states")
      .select("*")
      .eq("state", String(state))
      .is("used_at", null)
      .gt("expires_at", new Date().toISOString())
      .single();

    if (stateError || !oauthState) {
      return res.status(400).send(
        htmlPage("Instagram Connection Failed", `<h1>Invalid or expired OAuth state.</h1>`)
      );
    }

    callbackStep = "short_lived_token_exchange";
    const shortToken = await exchangeCodeForShortInstagramToken(code);

    callbackStep = "long_lived_token_exchange";
    const longResult = await exchangeShortTokenForLongInstagramToken(shortToken.access_token);

    let tokenToStore = shortToken.access_token;
    let expiresIn = 55 * 60;
    let tokenSource = "short_lived";
    let longExchangeWarning = null;

    if (longResult.ok && longResult.token?.access_token) {
      tokenToStore = longResult.token.access_token;
      expiresIn = Number(longResult.token.expires_in || 60 * 24 * 60 * 60);
      tokenSource = "long_lived";
      longExchangeWarning = longResult.warning;
    } else {
      longExchangeWarning = longResult.warning;
    }

    callbackStep = "profile_fetch";
    const profileResult = await fetchInstagramProfile(tokenToStore, shortToken);
    const profile = profileResult.profile || {};
    const igUserId = String(profileResult.igUserId || shortToken.user_id || "");

    if (!igUserId) {
      throw new Error("Could not determine Instagram user id.");
    }

    callbackStep = "database_save";
    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const encryptedToken = encryptText(tokenToStore);

    const accountPayload = {
      user_id: oauthState.user_id,
      platform: "instagram",
      ig_user_id: igUserId,
      username: profile.username || null,
      account_type: profile.account_type || null,
      encrypted_access_token: encryptedToken,
      token_expires_at: tokenExpiresAt,
      token_type: tokenSource,
      token_last_refreshed_at: null,
      token_refresh_error:
        tokenSource === "long_lived"
          ? null
          : "Long-lived token exchange failed; reconnect may be required soon.",
      scopes: instagramScopes(),
      status: "connected",
      updated_at: new Date().toISOString(),
    };

    const { data: existingAccount, error: existingError } = await supabase
      .from("social_accounts")
      .select("id,user_id,platform,ig_user_id,username,status")
      .eq("platform", "instagram")
      .eq("ig_user_id", igUserId)
      .maybeSingle();

    if (existingError) {
      throw new Error(existingError.message);
    }

    let savedAccount = null;

    if (existingAccount) {
      if (existingAccount.user_id !== oauthState.user_id) {
        throw new Error(
          "This Instagram account is already connected to another user. Disconnect it from the old user first."
        );
      }

      const { data: updatedAccount, error: updateError } = await supabase
        .from("social_accounts")
        .update(accountPayload)
        .eq("id", existingAccount.id)
        .eq("user_id", oauthState.user_id)
        .select("id,username,ig_user_id,account_type,status,token_type,token_expires_at")
        .single();

      if (updateError) {
        throw new Error(updateError.message);
      }

      savedAccount = updatedAccount;
    } else {
      const { data: insertedAccount, error: insertError } = await supabase
        .from("social_accounts")
        .insert(accountPayload)
        .select("id,username,ig_user_id,account_type,status,token_type,token_expires_at")
        .single();

      if (insertError) {
        throw new Error(insertError.message);
      }

      savedAccount = insertedAccount;
    }

    await supabase
      .from("oauth_states")
      .update({ used_at: new Date().toISOString() })
      .eq("state", String(state));

    if (profileResult.fallbackUsed) {
      await addPublishLog({
        userId: oauthState.user_id,
        socialAccountId: savedAccount.id,
        action: "instagram_profile_fetch_fallback_used",
        status: "warning",
        message: "Instagram profile fetch failed. Saved account using user_id from token response.",
        meta: {
          fallback: "short_token_user_id",
          attempts: profileResult.errors || [],
        },
      });
    }

    if (tokenSource === "short_lived") {
      await addPublishLog({
        userId: oauthState.user_id,
        socialAccountId: savedAccount.id,
        action: "instagram_long_lived_token_exchange_failed",
        status: "warning",
        message: "Long-lived token exchange failed. Stored short-lived token temporarily.",
        meta: {
          fallback: "short_lived_token",
          warning: longExchangeWarning,
        },
      });
    } else if (longExchangeWarning) {
      await addPublishLog({
        userId: oauthState.user_id,
        socialAccountId: savedAccount.id,
        action: "instagram_long_lived_token_exchange_warning",
        status: "warning",
        message: "Long-lived token exchange succeeded after fallback method.",
        meta: longExchangeWarning,
      });
    }

    await addPublishLog({
      userId: oauthState.user_id,
      socialAccountId: savedAccount.id,
      action: "instagram_account_connected",
      status: "success",
      message: "Instagram account connected successfully.",
      meta: {
        username: savedAccount.username || null,
        igUserId: savedAccount.ig_user_id,
        accountType: savedAccount.account_type || null,
        tokenSource,
        profileFetchAttempt: profileResult.attempt,
        profileFallbackUsed: profileResult.fallbackUsed || false,
      },
    });

    const successUrl = process.env.FRONTEND_SUCCESS_URL;

    return res.send(
      htmlPage(
        "Instagram Connected",
        `
        <h1>Instagram connected successfully.</h1>
        <p>Connected account: <b>${escapeHtml(savedAccount.username || igUserId)}</b></p>
        <p>Token type stored: <b>${escapeHtml(tokenSource)}</b></p>
        ${
          profileResult.fallbackUsed
            ? `<p style="color:#b45309;"><b>Warning:</b> Username could not be fetched right now, so the account was saved using Instagram user ID. The app can refresh profile data later.</p>`
            : ""
        }
        ${
          tokenSource === "short_lived"
            ? `<p style="color:#b45309;"><b>Warning:</b> Long-lived token exchange failed, so the connection is temporary. Publishing may fail after about 1 hour until long-lived token exchange is fixed.</p>`
            : ""
        }
        <p>You can close this window and return to the app.</p>
        ${successUrl ? `<p><a href="${escapeHtml(successUrl)}">Return to app</a></p>` : ""}
      `
      )
    );
  } catch (err) {
    console.error("Instagram callback error:", {
      step: callbackStep,
      error: cleanErrorMessage(err),
      details: safeErrorDetails(err),
      profileFetchAttempts: err?.profileFetchAttempts || null,
    });

    const errorUrl = process.env.FRONTEND_ERROR_URL;

    return res.status(500).send(
      htmlPage(
        "Instagram Connection Failed",
        `
        <h1>Instagram connection failed</h1>
        <p><b>Step:</b> ${escapeHtml(callbackStep)}</p>
        <p><b>Error:</b> ${escapeHtml(cleanErrorMessage(err))}</p>
        ${errorUrl ? `<p><a href="${escapeHtml(errorUrl)}">Return to app</a></p>` : ""}
      `
      )
    );
  }
});

/* Accounts */

app.get("/api/accounts", requireUser, async (req, res) => {
  try {
    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
      .from("social_accounts")
      .select(
        "id,platform,ig_user_id,username,account_type,status,token_type,token_expires_at,token_last_refreshed_at,token_refresh_error,created_at,updated_at"
      )
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);

    return res.json({ ok: true, accounts: data || [] });
  } catch (error) {
    return res.status(500).json({ ok: false, error: cleanErrorMessage(error) });
  }
});

app.post("/api/accounts/:id/refresh-token", requireUser, async (req, res) => {
  try {
    const account = await getAccountForUser({
      userId: req.user.id,
      accountId: req.params.id,
      includeToken: true,
    });

    await getUsableInstagramToken({ account, forceRefresh: true });

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("social_accounts")
      .select(
        "id,platform,ig_user_id,username,account_type,status,token_type,token_expires_at,token_last_refreshed_at,token_refresh_error,created_at,updated_at"
      )
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .single();

    if (error) throw new Error(error.message);

    return res.json({ ok: true, account: data });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: safeErrorDetails(error),
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

    return res.json({ ok: true, account: data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: cleanErrorMessage(error) });
  }
});

/* Media */

app.get("/api/media/assets", requireUser, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 300);
    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
      .from("media_assets")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw new Error(error.message);

    return res.json({
      ok: true,
      assets: data || [],
      media: data || [],
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: cleanErrorMessage(error) });
  }
});

app.get("/api/media", requireUser, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 300);
    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
      .from("media_assets")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw new Error(error.message);

    return res.json({
      ok: true,
      assets: data || [],
      media: data || [],
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: cleanErrorMessage(error) });
  }
});

app.post("/api/media/upload", requireUser, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Missing file." });
    }

    const allowed = req.file.mimetype.startsWith("image/") || req.file.mimetype.startsWith("video/");
    if (!allowed) {
      return res.status(400).json({ ok: false, error: "Only image and video files are allowed." });
    }

    const data = await saveMediaAssetFromBuffer({
      userId: req.user.id,
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      originalname: req.file.originalname,
      folderSuffix: "uploads",
    });

    return res.json({ ok: true, asset: data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: cleanErrorMessage(error) });
  }
});

app.delete("/api/media/:id", requireUser, async (req, res) => {
  try {
    const mediaId = req.params.id;
    const supabase = getSupabaseAdmin();

    const { data: asset, error: assetError } = await supabase
      .from("media_assets")
      .select("*")
      .eq("id", mediaId)
      .eq("user_id", req.user.id)
      .single();

    if (assetError || !asset) {
      return res.status(404).json({
        ok: false,
        error: "Media asset not found for this user.",
      });
    }

    // مهم:
    // هون بس منعرف إذا الصورة مستخدمة ببوستات.
    // ما منحذف ولا منعدل أي بوست منشور أو مجدول.
    const { data: linkedPosts, error: linkedPostsError } = await supabase
      .from("scheduled_posts")
      .select("id,status,published_media_id,published_permalink")
      .eq("media_asset_id", mediaId)
      .eq("user_id", req.user.id);

    if (linkedPostsError) {
      throw new Error(linkedPostsError.message);
    }

    let cloudinaryDeleted = false;
    let cloudinaryResult = null;

    if (asset.cloudinary_public_id) {
      configureCloudinary();

      const resourceType =
        asset.resource_type === "video" || asset.resource_type === "raw"
          ? asset.resource_type
          : "image";

      cloudinaryResult = await cloudinary.uploader.destroy(
        asset.cloudinary_public_id,
        {
          resource_type: resourceType,
          invalidate: true,
        }
      );

      cloudinaryDeleted =
        cloudinaryResult?.result === "ok" ||
        cloudinaryResult?.result === "not found";

      if (!cloudinaryDeleted) {
        return res.status(500).json({
          ok: false,
          error: "Failed to delete media from Cloudinary.",
          cloudinary_result: cloudinaryResult,
        });
      }
    }

    // حذف الصورة من مكتبة المستخدم فقط.
    // لا نحذف scheduled_posts.
    // لا نحذف أي بوست من Instagram.
    const { error: deleteError } = await supabase
      .from("media_assets")
      .delete()
      .eq("id", mediaId)
      .eq("user_id", req.user.id);

    if (deleteError) {
      throw new Error(deleteError.message);
    }

    return res.json({
      ok: true,
      deleted: true,
      media_id: mediaId,
      cloudinary_public_id: asset.cloudinary_public_id || null,
      cloudinary_deleted: Boolean(asset.cloudinary_public_id)
        ? cloudinaryDeleted
        : false,
      cloudinary_result: cloudinaryResult,
      linked_posts_count: Array.isArray(linkedPosts) ? linkedPosts.length : 0,
      linked_posts_untouched: true,
      message:
        "Media deleted from this user's library and Cloudinary. Existing posts were not deleted or modified.",
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: safeErrorDetails(error),
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

    if (req.query.status) query = query.eq("status", String(req.query.status));

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return res.json({ ok: true, posts: data || [] });
  } catch (error) {
    return res.status(500).json({ ok: false, error: cleanErrorMessage(error) });
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
      return res.status(400).json({ ok: false, error: "social_account_id is required." });
    }
    if (!media_asset_id) {
      return res.status(400).json({ ok: false, error: "media_asset_id is required." });
    }
    if (!scheduled_at) {
      return res.status(400).json({ ok: false, error: "scheduled_at is required." });
    }

    if (String(media_asset_id).startsWith("media_")) {
      return res.status(400).json({
        ok: false,
        error: "Invalid media_asset_id. The app sent a local temporary media id instead of the backend media_assets.id returned from upload.",
        media_asset_id,
      });
    }

    const account = await getAccountForUser({
      userId: req.user.id,
      accountId: social_account_id,
      includeToken: false,
    });

    const asset = await getMediaAssetForUser({
      userId: req.user.id,
      mediaAssetId: media_asset_id,
    });

    const detectedMediaType = media_type || (asset.resource_type === "video" ? "video" : "image");

    const { data, error } = await getSupabaseAdmin()
      .from("scheduled_posts")
      .insert({
        user_id: req.user.id,
        social_account_id: account.id,
        media_asset_id: asset.id,
        caption: caption || "",
        media_url: normalizeSecureUrl(asset),
        media_type: detectedMediaType,
        scheduled_at,
        timezone: timezone || "Asia/Dubai",
        status: "scheduled",
      })
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    return res.json({ ok: true, post: data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: cleanErrorMessage(error) });
  }
});

app.post("/api/posts/publish-now", requireUser, async (req, res) => {
  try {
    const { post_id, social_account_id, media_asset_id, caption, media_type } = req.body;
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

      const asset = await getMediaAssetForUser({
        userId: req.user.id,
        mediaAssetId: media_asset_id,
      });

      const detectedMediaType = media_type || (asset.resource_type === "video" ? "video" : "image");

      const { data: created, error: createError } = await supabase
        .from("scheduled_posts")
        .insert({
          user_id: req.user.id,
          social_account_id: account.id,
          media_asset_id: asset.id,
          caption: caption || "",
          media_url: normalizeSecureUrl(asset),
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

    const result = await publishPostById({ postId, userId: req.user.id });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: safeErrorDetails(error),
    });
  }
});

app.post("/api/posts/:id/retry", requireUser, async (req, res) => {
  try {
    const result = await publishPostById({ postId: req.params.id, userId: req.user.id });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: safeErrorDetails(error),
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

    return res.json({ ok: true, post: data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: cleanErrorMessage(error) });
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
        const result = await publishPostById({ postId: post.id, userId: null });
        results.push({ post_id: post.id, ok: true, result });
      } catch (err) {
        results.push({ post_id: post.id, ok: false, error: cleanErrorMessage(err) });
      }
    }

    return res.json({ ok: true, count: results.length, results });
  } catch (error) {
    return res.status(500).json({ ok: false, error: cleanErrorMessage(error) });
  }
});

/* Insights */

app.get("/api/insights/account", requireUser, async (req, res) => {
  try {
    const accountId = req.query.account_id;
    if (!accountId) {
      return res.status(400).json({ ok: false, error: "account_id is required." });
    }

    const account = await getAccountForUser({ userId: req.user.id, accountId, includeToken: true });
    const token = await getUsableInstagramToken({ account });
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

    return res.json({ ok: true, insights: data });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: safeErrorDetails(error),
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

    if (postError || !post) throw new Error("Post not found.");

    if (!post.published_media_id) {
      return res.status(400).json({ ok: false, error: "Post is not published yet." });
    }

    const account = await getAccountForUser({
      userId: req.user.id,
      accountId: post.social_account_id,
      includeToken: true,
    });
    const token = await getUsableInstagramToken({ account });
    const metrics = String(
      req.query.metrics || "views,reach,total_interactions,likes,comments,shares,saved"
    )
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .join(",");

    const url = new URL(`https://graph.instagram.com/${graphVersion()}/${post.published_media_id}/insights`);
    url.searchParams.set("metric", metrics);
    url.searchParams.set("access_token", token);

    const data = await fetchJson(url.toString());

    return res.json({ ok: true, insights: data });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: safeErrorDetails(error),
    });
  }
});

/* Comments for posts published by this app */

app.get("/api/posts/:id/comments", requireUser, async (req, res) => {
  try {
    const supabase = getSupabaseAdmin();

    const { data: post, error: postError } = await supabase
      .from("scheduled_posts")
      .select("*")
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .single();

    if (postError || !post) throw new Error("Post not found.");

    if (!post.published_media_id) {
      return res.status(400).json({ ok: false, error: "Post is not published yet." });
    }

    const account = await getAccountForUser({
      userId: req.user.id,
      accountId: post.social_account_id,
      includeToken: true,
    });
    const token = await getUsableInstagramToken({ account });

    const url = new URL(`https://graph.instagram.com/${graphVersion()}/${post.published_media_id}/comments`);
    url.searchParams.set(
      "fields",
      "id,text,username,timestamp,like_count,replies{id,text,username,timestamp}"
    );
    url.searchParams.set("access_token", token);

    const data = await fetchJson(url.toString());

    return res.json({ ok: true, comments: data });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: safeErrorDetails(error),
    });
  }
});

app.post("/api/posts/:id/comments/:commentId/reply", requireUser, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !String(message).trim()) {
      return res.status(400).json({ ok: false, error: "message is required." });
    }

    const supabase = getSupabaseAdmin();
    const { data: post, error: postError } = await supabase
      .from("scheduled_posts")
      .select("*")
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .single();

    if (postError || !post) throw new Error("Post not found.");

    const account = await getAccountForUser({
      userId: req.user.id,
      accountId: post.social_account_id,
      includeToken: true,
    });
    const token = await getUsableInstagramToken({ account });

    const url = `https://graph.instagram.com/${graphVersion()}/${req.params.commentId}/replies`;
    const params = new URLSearchParams();
    params.set("message", String(message));
    params.set("access_token", token);

    const data = await fetchJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });

    return res.json({ ok: true, reply: data });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: safeErrorDetails(error),
    });
  }
});

/* Instagram account media and comments */

app.get("/api/instagram/media", requireUser, async (req, res) => {
  try {
    const accountId = req.query.account_id;

    if (!accountId) {
      return res.status(400).json({ ok: false, error: "account_id is required." });
    }

    const limit = Math.min(
      Math.max(Number(req.query.limit || 25), 1),
      Number(process.env.IG_MEDIA_MAX_LIMIT || 50)
    );

    const account = await getAccountForUser({ userId: req.user.id, accountId, includeToken: true });
    const token = await getUsableInstagramToken({ account });

    const url = new URL(`https://graph.instagram.com/${graphVersion()}/${account.ig_user_id}/media`);
    url.searchParams.set(
      "fields",
      "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,comments_count,like_count"
    );
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("access_token", token);

    const data = await fetchJson(url.toString());

    return res.json({
      ok: true,
      account_id: account.id,
      ig_user_id: account.ig_user_id,
      media: data,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: safeErrorDetails(error),
    });
  }
});

app.get("/api/instagram/media/:mediaId/comments", requireUser, async (req, res) => {
  try {
    const accountId = req.query.account_id;
    const mediaId = req.params.mediaId;

    if (!accountId) {
      return res.status(400).json({ ok: false, error: "account_id is required." });
    }
    if (!mediaId) {
      return res.status(400).json({ ok: false, error: "mediaId is required." });
    }

    const limit = Math.min(
      Math.max(Number(req.query.limit || 50), 1),
      Number(process.env.IG_COMMENTS_MAX_LIMIT || 100)
    );

    const account = await getAccountForUser({ userId: req.user.id, accountId, includeToken: true });
    const token = await getUsableInstagramToken({ account });

    const url = new URL(`https://graph.instagram.com/${graphVersion()}/${mediaId}/comments`);
    url.searchParams.set(
      "fields",
      "id,text,username,timestamp,like_count,replies{id,text,username,timestamp}"
    );
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("access_token", token);

    const data = await fetchJson(url.toString());

    return res.json({
      ok: true,
      account_id: account.id,
      ig_user_id: account.ig_user_id,
      media_id: mediaId,
      comments: data,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: safeErrorDetails(error),
    });
  }
});

app.get("/api/instagram/comments/all", requireUser, async (req, res) => {
  try {
    const accountId = req.query.account_id;

    if (!accountId) {
      return res.status(400).json({ ok: false, error: "account_id is required." });
    }

    const mediaLimit = Math.min(
      Math.max(Number(req.query.media_limit || 25), 1),
      Number(process.env.IG_MEDIA_MAX_LIMIT || 50)
    );
    const commentsLimit = Math.min(
      Math.max(Number(req.query.comments_limit || 50), 1),
      Number(process.env.IG_COMMENTS_MAX_LIMIT || 100)
    );

    const account = await getAccountForUser({ userId: req.user.id, accountId, includeToken: true });
    const token = await getUsableInstagramToken({ account });

    const mediaUrl = new URL(`https://graph.instagram.com/${graphVersion()}/${account.ig_user_id}/media`);
    mediaUrl.searchParams.set(
      "fields",
      "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,comments_count,like_count"
    );
    mediaUrl.searchParams.set("limit", String(mediaLimit));
    mediaUrl.searchParams.set("access_token", token);

    const mediaData = await fetchJson(mediaUrl.toString());
    const mediaItems = Array.isArray(mediaData?.data) ? mediaData.data : [];
    const items = [];

    for (const media of mediaItems) {
      const mediaId = media?.id;

      if (!mediaId) {
        items.push({ media, comments: [], error: "Media id is missing." });
        continue;
      }

      try {
        const commentsUrl = new URL(`https://graph.instagram.com/${graphVersion()}/${mediaId}/comments`);
        commentsUrl.searchParams.set(
          "fields",
          "id,text,username,timestamp,like_count,replies{id,text,username,timestamp}"
        );
        commentsUrl.searchParams.set("limit", String(commentsLimit));
        commentsUrl.searchParams.set("access_token", token);

        const commentsData = await fetchJson(commentsUrl.toString());

        items.push({
          media,
          comments: Array.isArray(commentsData?.data) ? commentsData.data : [],
          paging: commentsData?.paging || null,
          error: null,
        });
      } catch (commentError) {
        items.push({
          media,
          comments: [],
          error: cleanErrorMessage(commentError),
          meta: safeErrorDetails(commentError),
        });
      }
    }

    return res.json({
      ok: true,
      account_id: account.id,
      ig_user_id: account.ig_user_id,
      media_count: mediaItems.length,
      items,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: safeErrorDetails(error),
    });
  }
});

app.post("/api/instagram/comments/:commentId/reply", requireUser, async (req, res) => {
  try {
    const accountId = req.body.account_id || req.body.social_account_id || req.body.accountId;
    const commentId = req.params.commentId;
    const message = req.body.message;

    if (!accountId) {
      return res.status(400).json({ ok: false, error: "account_id is required." });
    }
    if (!commentId) {
      return res.status(400).json({ ok: false, error: "commentId is required." });
    }
    if (!message || !String(message).trim()) {
      return res.status(400).json({ ok: false, error: "message is required." });
    }

    const account = await getAccountForUser({ userId: req.user.id, accountId, includeToken: true });
    const token = await getUsableInstagramToken({ account });

    const url = `https://graph.instagram.com/${graphVersion()}/${commentId}/replies`;
    const params = new URLSearchParams();
    params.set("message", String(message));
    params.set("access_token", token);

    const data = await fetchJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });

    return res.json({
      ok: true,
      account_id: account.id,
      comment_id: commentId,
      reply: data,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: safeErrorDetails(error),
    });
  }
});

/* Messaging proxy */

app.get("/api/messages/conversations", requireUser, async (req, res) => {
  try {
    const accountId = req.query.account_id;
    if (!accountId) {
      return res.status(400).json({ ok: false, error: "account_id is required." });
    }

    const account = await getAccountForUser({ userId: req.user.id, accountId, includeToken: true });
    const token = await getUsableInstagramToken({ account });

    const url = new URL(`https://graph.instagram.com/${graphVersion()}/${account.ig_user_id}/conversations`);
    url.searchParams.set(
      "fields",
      "id,participants,updated_time,messages.limit(20){id,from,to,message,created_time}"
    );
    url.searchParams.set("platform", "instagram");
    url.searchParams.set("access_token", token);

    const data = await fetchJson(url.toString());

    return res.json({ ok: true, conversations: data });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: safeErrorDetails(error),
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

    const account = await getAccountForUser({ userId: req.user.id, accountId: account_id, includeToken: true });
    const token = await getUsableInstagramToken({ account });

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

    return res.json({ ok: true, sent: data });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: safeErrorDetails(error),
    });
  }
});

/* AI / Gemini */

app.get("/api/ai/models", requireUser, async (req, res) => {
  try {
    const apiKey = getGeminiApiKey(req);

    if (!apiKey) {
      return missingGeminiKeyResponse(res);
    }

    const data = await fetchGeminiModels(apiKey);
    const models = Array.isArray(data?.models) ? data.models : [];

    return res.json({
      ok: true,
      provider: "gemini",
      using_backend_key: !req.headers["x-gemini-api-key"],
      models,
    });
  } catch (error) {
    return res.status(error?.status || 500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: safeErrorDetails(error),
    });
  }
});

app.post("/api/ai/test", requireUser, async (req, res) => {
  try {
    const apiKey = getGeminiApiKey(req);

    if (!apiKey) {
      return missingGeminiKeyResponse(res);
    }

    const model = requireGeminiModel(req, res);
    if (!model) return;

    const data = await generateGeminiText({
      apiKey,
      model,
      prompt:
        "Reply with exactly this sentence if you can read this: AI connection successful.",
    });

    const text = extractGeminiText(data);

    return res.json({
      ok: true,
      provider: "gemini",
      model,
      message: "AI connection successful",
      text: text || "AI connection successful",
    });
  } catch (error) {
    return res.status(error?.status || 500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: safeErrorDetails(error),
    });
  }
});

app.post("/api/ai/generate", requireUser, async (req, res) => {
  try {
    const apiKey = getGeminiApiKey(req);

    if (!apiKey) {
      return missingGeminiKeyResponse(res);
    }

    const model = requireGeminiModel(req, res);
    if (!model) return;

    const prompt = req.body?.prompt;

    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({
        ok: false,
        error: "prompt is required.",
      });
    }

    const data = await generateGeminiText({
      apiKey,
      model,
      prompt,
    });

    const text = extractGeminiText(data);

    return res.json({
      ok: true,
      provider: "gemini",
      model,
      text,
      raw: process.env.RETURN_RAW_AI_RESPONSE === "true" ? data : undefined,
    });
  } catch (error) {
    return res.status(error?.status || 500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: safeErrorDetails(error),
    });
  }
});

async function handleAiImageEdit(req, res) {
  try {
    const apiKey = getGeminiApiKey(req);

    if (!apiKey) {
      return missingGeminiKeyResponse(res);
    }

    const model = requireGeminiModel(req, res);
    if (!model) return;

    const prompt =
      req.body?.prompt ||
      req.body?.edit_prompt ||
      req.body?.instruction;

    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({
        ok: false,
        error: "prompt is required.",
      });
    }

    let imageBuffer = null;
    let imageMimeType = "image/jpeg";

    if (req.file?.buffer) {
      imageBuffer = req.file.buffer;
      imageMimeType = req.file.mimetype || "image/jpeg";
    } else if (req.body?.media_asset_id || req.body?.mediaAssetId) {
      const mediaAssetId = req.body.media_asset_id || req.body.mediaAssetId;
      const asset = await getMediaAssetForUser({
        userId: req.user.id,
        mediaAssetId,
      });

      const url = normalizeSecureUrl(asset);

      if (!url) {
        throw new Error("Media asset has no usable URL.");
      }

      const downloaded = await fetchBuffer(url);
      imageBuffer = downloaded.buffer;
      imageMimeType = downloaded.mimetype;
    } else if (req.body?.image_url || req.body?.imageUrl) {
      const downloaded = await fetchBuffer(req.body.image_url || req.body.imageUrl);
      imageBuffer = downloaded.buffer;
      imageMimeType = downloaded.mimetype;
    } else {
      return res.status(400).json({
        ok: false,
        error: "file, image_url, or media_asset_id is required.",
      });
    }

    const finalPrompt = buildImageEditPrompt({
      prompt,
      aspectRatio: req.body?.aspect_ratio || req.body?.aspectRatio,
      resolution: req.body?.resolution,
      preserveProduct:
        req.body?.preserve_product === true ||
        req.body?.preserveProduct === true ||
        String(req.body?.preserve_product).toLowerCase() === "true" ||
        String(req.body?.preserveProduct).toLowerCase() === "true",
      preservePlanter:
        req.body?.preserve_planter === true ||
        req.body?.preservePlanter === true ||
        String(req.body?.preserve_planter).toLowerCase() === "true" ||
        String(req.body?.preservePlanter).toLowerCase() === "true",
    });

    const result = await generateGeminiImage({
      apiKey,
      model,
      prompt: finalPrompt,
      imageBuffer,
      imageMimeType,
    });

    const image = extractGeminiInlineImage(result);
    const text = extractGeminiText(result);

    if (!image?.buffer?.length) {
      return res.status(502).json({
        ok: false,
        error:
          text ||
          "The selected Gemini model did not return an image. Select an image-capable model from the app.",
        model,
      });
    }

    const asset = await saveMediaAssetFromBuffer({
      userId: req.user.id,
      buffer: image.buffer,
      mimetype: image.mimetype,
      originalname: `ai-edited-${Date.now()}.png`,
      folderSuffix: "ai-edits",
    });

    return res.json({
      ok: true,
      provider: "gemini",
      model,
      asset,
      message: "Edited image saved to your library.",
      text,
    });
  } catch (error) {
    return res.status(error?.status || 500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: safeErrorDetails(error),
    });
  }
}

async function handleAiImageGenerate(req, res) {
  try {
    const apiKey = getGeminiApiKey(req);

    if (!apiKey) {
      return missingGeminiKeyResponse(res);
    }

    const model = requireGeminiModel(req, res);
    if (!model) return;

    const prompt = req.body?.prompt;

    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({
        ok: false,
        error: "prompt is required.",
      });
    }

    const result = await generateGeminiImage({
      apiKey,
      model,
      prompt,
      imageBuffer: null,
      imageMimeType: null,
    });

    const image = extractGeminiInlineImage(result);
    const text = extractGeminiText(result);

    if (!image?.buffer?.length) {
      return res.status(502).json({
        ok: false,
        error:
          text ||
          "The selected Gemini model did not return an image. Select an image-capable model from the app.",
        model,
      });
    }

    const asset = await saveMediaAssetFromBuffer({
      userId: req.user.id,
      buffer: image.buffer,
      mimetype: image.mimetype,
      originalname: `ai-generated-${Date.now()}.png`,
      folderSuffix: "ai-generated",
    });

    return res.json({
      ok: true,
      provider: "gemini",
      model,
      asset,
      message: "Generated image saved to your library.",
      text,
    });
  } catch (error) {
    return res.status(error?.status || 500).json({
      ok: false,
      error: cleanErrorMessage(error),
      meta: safeErrorDetails(error),
    });
  }
}

app.post("/api/ai/image/edit", requireUser, upload.single("file"), handleAiImageEdit);
app.post("/api/ai/edit-image", requireUser, upload.single("file"), handleAiImageEdit);
app.post("/api/image/edit", requireUser, upload.single("file"), handleAiImageEdit);
app.post("/api/ai/image/generate", requireUser, handleAiImageGenerate);

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

    return res.json({ ok: true, logs: data || [] });
  } catch (error) {
    return res.status(500).json({ ok: false, error: cleanErrorMessage(error) });
  }
});

/* Not found and error handlers */

app.use((req, res) => {
  console.warn("Route not found:", {
    method: req.method,
    path: req.path,
    originalUrl: req.originalUrl,
  });

  res.status(404).json({
    ok: false,
    error: "Route not found.",
    method: req.method,
    path: req.path,
    originalUrl: req.originalUrl,
  });
});

app.use((err, req, res, next) => {
  console.error("Unhandled server error:", cleanErrorMessage(err));
  res.status(500).json({ ok: false, error: "Internal server error." });
});

app.listen(PORT, () => {
  console.log(`SocialFlow API running on port ${PORT}`);
});
