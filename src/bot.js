require("dotenv").config();

const { promises: fsp } = require("fs");
const path = require("path");
const axios = require("axios");
const { Telegraf, Markup } = require("telegraf");
const {
  pick,
  normalizeResult,
  extractUrls,
  deduplicateLinks,
  extractBulkRows,
  buildBulkLines,
  chunkLines,
} = require("./core");

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_BASE_URL = process.env.API_BASE_URL || "https://telecheck.vercel.app";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);
const BULK_REPLY_PROMPT = "Reply to this message with all links to validate (space/newline separated).";

const MAX_MESSAGE_CHARS = Number(process.env.MAX_MESSAGE_CHARS || 12000);
const MAX_LINKS_PER_BULK = Number(process.env.MAX_LINKS_PER_BULK || 300);
const REPLY_CHUNK_MAX_LEN = Number(process.env.REPLY_CHUNK_MAX_LEN || 3500);
const RETRY_ATTEMPTS = Number(process.env.RETRY_ATTEMPTS || 3);
const RETRY_BASE_DELAY_MS = Number(process.env.RETRY_BASE_DELAY_MS || 400);
const RATE_LIMIT_COUNT = Number(process.env.RATE_LIMIT_COUNT || 20);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const AUTH_PASSWORD = String(process.env.AUTH_PASSWORD || "").trim();
const AUTH_STORE_FILE = process.env.AUTH_STORE_FILE || "./data/auth-users.json";
const USER_PREFS_STORE_FILE = process.env.USER_PREFS_STORE_FILE || "./data/user-settings.json";
const ALLOWED_CHAT_IDS = parseIdList(process.env.ALLOWED_CHAT_IDS || "");
const ADMIN_USER_IDS = parseIdList(process.env.ADMIN_USER_IDS || "");

const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN || "";
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/telegram/webhook";
const WEBHOOK_PORT = Number(process.env.WEBHOOK_PORT || process.env.PORT || 3000);
const WEBHOOK_SECRET_TOKEN = process.env.WEBHOOK_SECRET_TOKEN || undefined;

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN in environment.");

const startedAt = Date.now();
const bot = new Telegraf(BOT_TOKEN);
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: REQUEST_TIMEOUT_MS,
});
const rateLimiter = new Map();
const authenticatedUsers = new Set();
const authStorePath = path.isAbsolute(AUTH_STORE_FILE) ? AUTH_STORE_FILE : path.resolve(process.cwd(), AUTH_STORE_FILE);
const userPrefs = new Map();
const userPrefsStorePath = path.isAbsolute(USER_PREFS_STORE_FILE) ? USER_PREFS_STORE_FILE : path.resolve(process.cwd(), USER_PREFS_STORE_FILE);

function parseIdList(value) {
  return new Set(
    String(value)
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => Number(v))
      .filter(Number.isFinite)
  );
}

function hasPasswordAuth() {
  return Boolean(AUTH_PASSWORD);
}

function isAuthenticated(ctx) {
  if (!hasPasswordAuth()) return true;
  const userId = Number(ctx?.from?.id);
  return Number.isFinite(userId) && authenticatedUsers.has(userId);
}

function isAuthExemptMessage(text) {
  return /^\/(start|help|auth)(@\w+)?(\s|$)/i.test(String(text || ""));
}

function getUserPref(userId) {
  const id = Number(userId);
  const saved = Number.isFinite(id) ? userPrefs.get(id) : null;
  return {
    showInvalidBulk: saved?.showInvalidBulk !== false,
  };
}

function shouldShowInvalidBulkForCtx(ctx) {
  const userId = Number(ctx?.from?.id);
  return getUserPref(userId).showInvalidBulk;
}

function mainKeyboard(ctx) {
  const rows = [];
  if (hasPasswordAuth() && !isAuthenticated(ctx)) {
    rows.push(["/auth"]);
    rows.push(["/help"]);
    return Markup.keyboard(rows).resize();
  }

  rows.push(["/check", "/bulk"]);
  rows.push(["/stats", "/invalid"]);
  rows.push(["/help"]);
  if (isAdmin(ctx)) rows.push(["/health"]);
  return Markup.keyboard(rows).resize();
}

async function loadAuthenticatedUsers() {
  try {
    const raw = await fsp.readFile(authStorePath, "utf8");
    const parsed = JSON.parse(raw);
    const ids = Array.isArray(parsed?.user_ids) ? parsed.user_ids : [];
    for (const id of ids.map((v) => Number(v)).filter(Number.isFinite)) {
      authenticatedUsers.add(id);
    }
    log("info", "auth_store_loaded", { file: authStorePath, users: authenticatedUsers.size });
  } catch (err) {
    if (err?.code === "ENOENT") {
      log("info", "auth_store_not_found", { file: authStorePath });
      return;
    }
    log("error", "auth_store_load_failed", { file: authStorePath, message: err.message });
  }
}

async function loadUserPrefs() {
  try {
    const raw = await fsp.readFile(userPrefsStorePath, "utf8");
    const parsed = JSON.parse(raw);
    const entries = parsed && typeof parsed === "object" ? parsed.users : null;
    if (!entries || typeof entries !== "object") {
      log("info", "user_prefs_store_loaded", { file: userPrefsStorePath, users: 0 });
      return;
    }
    for (const [k, v] of Object.entries(entries)) {
      const id = Number(k);
      if (!Number.isFinite(id)) continue;
      const showInvalidBulk = v?.showInvalidBulk !== false;
      userPrefs.set(id, { showInvalidBulk });
    }
    log("info", "user_prefs_store_loaded", { file: userPrefsStorePath, users: userPrefs.size });
  } catch (err) {
    if (err?.code === "ENOENT") {
      log("info", "user_prefs_store_not_found", { file: userPrefsStorePath });
      return;
    }
    log("error", "user_prefs_store_load_failed", { file: userPrefsStorePath, message: err.message });
  }
}

async function persistAuthenticatedUsers() {
  const dir = path.dirname(authStorePath);
  await fsp.mkdir(dir, { recursive: true });
  const payload = { user_ids: [...authenticatedUsers].sort((a, b) => a - b) };
  await fsp.writeFile(authStorePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function persistUserPrefs() {
  const dir = path.dirname(userPrefsStorePath);
  await fsp.mkdir(dir, { recursive: true });
  const users = {};
  for (const [userId, pref] of userPrefs.entries()) {
    users[String(userId)] = { showInvalidBulk: pref?.showInvalidBulk !== false };
  }
  const payload = { users };
  await fsp.writeFile(userPrefsStorePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function authenticateUser(userId) {
  if (!Number.isFinite(userId)) return false;
  if (authenticatedUsers.has(userId)) return false;
  authenticatedUsers.add(userId);
  await persistAuthenticatedUsers();
  return true;
}

async function setShowInvalidBulk(userId, showInvalidBulk) {
  const id = Number(userId);
  if (!Number.isFinite(id)) return;
  userPrefs.set(id, { showInvalidBulk: Boolean(showInvalidBulk) });
  await persistUserPrefs();
}

function nowIso() {
  return new Date().toISOString();
}

function log(level, msg, meta = {}) {
  const payload = { ts: nowIso(), level, msg, ...meta };
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else console.log(line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isRetryableError(err) {
  const status = err?.response?.status;
  if (status === 429) return true;
  if (typeof status === "number" && status >= 500) return true;
  return Boolean(err?.code === "ECONNRESET" || err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT");
}

async function withRetry(action, label, options = {}) {
  const suppressStatuses = new Set(options.suppressStatuses || []);
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await action();
    } catch (err) {
      lastErr = err;
      const retryable = isRetryableError(err);
      const canRetry = retryable && attempt < RETRY_ATTEMPTS;
      const status = err?.response?.status;
      if (!suppressStatuses.has(status)) {
        log("error", "api_call_failed", {
          label,
          attempt,
          retryable,
          status,
          code: err?.code,
          message: err?.message,
        });
      }
      if (!canRetry) break;
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function isAllowedChat(ctx) {
  if (ALLOWED_CHAT_IDS.size === 0) return true;
  const chatId = Number(ctx?.chat?.id);
  return ALLOWED_CHAT_IDS.has(chatId);
}

function isAdmin(ctx) {
  if (ADMIN_USER_IDS.size === 0) return true;
  const userId = Number(ctx?.from?.id);
  return ADMIN_USER_IDS.has(userId);
}

function consumeRateLimit(ctx) {
  const userId = String(ctx?.from?.id || "unknown");
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const arr = rateLimiter.get(userId) || [];
  const inWindow = arr.filter((t) => t >= windowStart);
  if (inWindow.length >= RATE_LIMIT_COUNT) {
    rateLimiter.set(userId, inWindow);
    return false;
  }
  inWindow.push(now);
  rateLimiter.set(userId, inWindow);
  return true;
}

function formatOne(result) {
  const icon = result.status === "valid" ? "[VALID]" : result.status === "invalid" ? "[INVALID]" : "[UNKNOWN]";
  return `${icon} <b>${escapeHtml(result.status.toUpperCase())}</b>\nLINK: <code>${escapeHtml(result.link)}</code>`;
}

async function replyInChunks(ctx, lines) {
  const chunks = chunkLines(lines, REPLY_CHUNK_MAX_LEN);
  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

async function checkSingle(link) {
  const { data } = await withRetry(() => api.get("/", { params: { link } }), "single");
  return normalizeResult({ ...(data || {}), link });
}

async function checkBulkFallback(links) {
  const settled = await Promise.allSettled(links.map((link) => checkSingle(link)));
  return settled.map((entry, idx) => {
    if (entry.status === "fulfilled") return entry.value;
    return normalizeResult({ link: links[idx], status: "unknown", reason: entry.reason?.message || "Check failed" });
  });
}

async function checkBulk(links) {
  const attempts = [
    () => api.post("/", { links }),
    () => api.post("/", links),
    () => api.post("/", { data: links }),
    () => api.post("/", { urls: links }),
  ];

  let lastErr;
  let hadSuccessfulResponse = false;
  for (const payloadAttempt of attempts) {
    try {
      const { data } = await withRetry(payloadAttempt, "bulk", {
        suppressStatuses: [400, 404, 405, 415, 422],
      });
      hadSuccessfulResponse = true;
      const rows = extractBulkRows(data, links);
      if (!rows) continue;

      const normalized = rows.map(normalizeResult);
      if (normalized.length === links.length) return normalized;
      if (normalized.length > 0) {
        const byLink = new Map(normalized.map((r) => [r.link, r]));
        return links.map((link) => byLink.get(link) || normalizeResult({ link, status: "unknown", reason: "Missing in bulk response" }));
      }
    } catch (err) {
      lastErr = err;
    }
  }

  if (lastErr && !hadSuccessfulResponse) {
    log("error", "bulk_fallback_to_single", { message: lastErr.message });
  } else {
    log("info", "bulk_fallback_to_single", { reason: "bulk_payload_or_response_not_supported" });
  }
  return checkBulkFallback(links);
}

async function getStats() {
  const { data } = await withRetry(() => api.get("/stats"), "stats");
  const total = pick(data, ["total", "totalChecked", "checked", "all", "count"]);
  const valid = pick(data, ["valid", "validCount", "ok"]);
  const invalid = pick(data, ["invalid", "invalidCount", "bad"]);
  const unknown = pick(data, ["unknown", "unknownCount"]);
  return { total, valid, invalid, unknown, raw: data };
}

async function guard(ctx) {
  if (!isAllowedChat(ctx)) {
    await ctx.reply("This chat is not allowed to use this bot.");
    return false;
  }
  const text = String(ctx?.message?.text || "");
  if (!isAuthenticated(ctx) && !isAuthExemptMessage(text)) {
    await ctx.reply("Password required. Use /auth <password>.", mainKeyboard(ctx));
    return false;
  }
  if (!consumeRateLimit(ctx)) {
    await ctx.reply("Rate limit hit. Please wait a bit and try again.");
    return false;
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    await ctx.reply(`Message too large. Max characters allowed: ${MAX_MESSAGE_CHARS}.`);
    return false;
  }
  return true;
}

bot.start(async (ctx) => {
  if (!(await guard(ctx))) return;
  return ctx.replyWithHTML(
    [
      "<b>TeleCheck Bot</b>",
      "",
      "Commands:",
      "/check &lt;link&gt; - check one link",
      "/bulk - request bulk mode prompt",
      "/auth &lt;password&gt; - authenticate this account",
      "/invalid &lt;on|off&gt; - show/hide invalid links in bulk output",
      "/stats - show API stats",
      "/health - runtime health",
      "/help - usage guide",
    ].join("\n"),
    mainKeyboard(ctx)
  );
});

bot.help(async (ctx) => {
  if (!(await guard(ctx))) return;
  return ctx.reply(
    [
      "Usage:",
      "0) /auth <password> (if password auth is enabled)",
      "1) /check https://t.me/example",
      "2) /bulk then reply to prompt with many links",
      "3) /stats",
      "4) /invalid on|off (bulk output preference)",
      `Limits: ${MAX_LINKS_PER_BULK} links per bulk request.`,
    ].join("\n"),
    mainKeyboard(ctx)
  );
});

bot.command("auth", async (ctx) => {
  if (!isAllowedChat(ctx)) {
    await ctx.reply("This chat is not allowed to use this bot.");
    return;
  }
  if (!hasPasswordAuth()) {
    await ctx.reply("Password auth is not enabled.", mainKeyboard(ctx));
    return;
  }

  const text = String(ctx?.message?.text || "");
  const supplied = text.replace(/^\/auth(@\w+)?\s*/i, "").trim();
  if (!supplied) {
    await ctx.reply("Provide password. Example: /auth your_password", mainKeyboard(ctx));
    return;
  }
  if (supplied !== AUTH_PASSWORD) {
    await ctx.reply("Invalid password.", mainKeyboard(ctx));
    return;
  }

  const userId = Number(ctx?.from?.id);
  try {
    const added = await authenticateUser(userId);
    if (added) {
      log("info", "user_authenticated", { user_id: userId, total: authenticatedUsers.size });
      await ctx.reply("Authentication successful.", mainKeyboard(ctx));
      return;
    }
    await ctx.reply("Already authenticated.", mainKeyboard(ctx));
  } catch (err) {
    log("error", "auth_store_persist_failed", { message: err.message });
    await ctx.reply("Authenticated for this run, but failed to persist auth store.", mainKeyboard(ctx));
  }
});

bot.command("health", async (ctx) => {
  if (!(await guard(ctx))) return;
  if (!isAdmin(ctx)) {
    await ctx.reply("Not authorized.");
    return;
  }
  const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
  await ctx.reply(
    [
      "ok",
      `uptime_sec: ${uptimeSec}`,
      `mode: ${WEBHOOK_DOMAIN ? "webhook" : "polling"}`,
      `api_base: ${API_BASE_URL}`,
      `rate_limit: ${RATE_LIMIT_COUNT}/${RATE_LIMIT_WINDOW_MS}ms`,
    ].join("\n")
  );
});

bot.command("invalid", async (ctx) => {
  if (!(await guard(ctx))) return;
  const text = String(ctx?.message?.text || "");
  const input = text.replace(/^\/invalid(@\w+)?\s*/i, "").trim().toLowerCase();

  if (!input) {
    const showInvalid = shouldShowInvalidBulkForCtx(ctx);
    await ctx.reply(
      `Invalid links in bulk output: ${showInvalid ? "ON" : "OFF"}\nUse: /invalid on or /invalid off`,
      mainKeyboard(ctx)
    );
    return;
  }

  let nextValue;
  if (["on", "show", "true", "yes", "1"].includes(input)) nextValue = true;
  else if (["off", "hide", "false", "no", "0"].includes(input)) nextValue = false;
  else {
    await ctx.reply("Invalid value. Use: /invalid on or /invalid off", mainKeyboard(ctx));
    return;
  }

  try {
    await setShowInvalidBulk(ctx?.from?.id, nextValue);
    await ctx.reply(
      `Updated: invalid links in bulk output are now ${nextValue ? "ON" : "OFF"}.`,
      mainKeyboard(ctx)
    );
  } catch (err) {
    log("error", "user_prefs_store_persist_failed", { message: err.message });
    await ctx.reply("Failed to save setting.", mainKeyboard(ctx));
  }
});

bot.command("stats", async (ctx) => {
  if (!(await guard(ctx))) return;
  try {
    const stats = await getStats();
    const lines = ["TeleCheck API Stats"];
    if (stats.total !== undefined) lines.push(`Total: ${stats.total}`);
    if (stats.valid !== undefined) lines.push(`Valid: ${stats.valid}`);
    if (stats.invalid !== undefined) lines.push(`Invalid: ${stats.invalid}`);
    if (stats.unknown !== undefined) lines.push(`Unknown: ${stats.unknown}`);
    lines.push(`Authenticated Users: ${authenticatedUsers.size}`);
    if (lines.length === 1) lines.push(JSON.stringify(stats.raw));
    await ctx.reply(lines.join("\n"));
  } catch (err) {
    log("error", "stats_failed", { message: err.message });
    await ctx.reply("Failed to fetch stats.");
  }
});

bot.command("check", async (ctx) => {
  if (!(await guard(ctx))) return;
  const text = ctx.message.text || "";
  const input = text.replace(/^\/check(@\w+)?\s*/i, "").trim();
  const link = extractUrls(input)[0] || input;
  if (!link) {
    await ctx.reply("Provide a link. Example: /check https://t.me/example");
    return;
  }

  try {
    const result = await checkSingle(link);
    await ctx.replyWithHTML(formatOne(result));
  } catch (err) {
    log("error", "single_failed", { message: err.message });
    await ctx.reply("Check failed.");
  }
});

bot.command("bulk", async (ctx) => {
  if (!(await guard(ctx))) return;
  await ctx.reply(BULK_REPLY_PROMPT);
});

bot.on("text", async (ctx) => {
  if (!(await guard(ctx))) return;
  const text = (ctx.message.text || "").trim();
  if (!text || text.startsWith("/")) return;

  const links = deduplicateLinks(extractUrls(text));
  if (links.length === 0) return;
  if (links.length > MAX_LINKS_PER_BULK) {
    await ctx.reply(`Too many links. Max allowed per bulk check: ${MAX_LINKS_PER_BULK}.`);
    return;
  }

  if (links.length === 1) {
    try {
      const result = await checkSingle(links[0]);
      await ctx.replyWithHTML(formatOne(result));
    } catch (err) {
      log("error", "single_text_failed", { message: err.message });
      await ctx.reply("Check failed.");
    }
    return;
  }

  await ctx.reply(`Checking ${links.length} links...`);
  try {
    const results = await checkBulk(links);
    const lines = buildBulkLines(results, { showInvalid: shouldShowInvalidBulkForCtx(ctx) });
    await replyInChunks(ctx, lines);
  } catch (err) {
    log("error", "bulk_failed", { message: err.message });
    await ctx.reply("Bulk check failed.");
  }
});

bot.catch((err, ctx) => {
  log("error", "bot_uncaught", {
    message: err?.message,
    user_id: ctx?.from?.id,
    chat_id: ctx?.chat?.id,
  });
  if (ctx) ctx.reply("Unexpected error occurred.").catch(() => {});
});

async function launch() {
  await loadAuthenticatedUsers();
  await loadUserPrefs();
  if (WEBHOOK_DOMAIN) {
    await bot.launch({
      webhook: {
        domain: WEBHOOK_DOMAIN,
        port: WEBHOOK_PORT,
        hookPath: WEBHOOK_PATH,
        secretToken: WEBHOOK_SECRET_TOKEN,
      },
    });
    log("info", "bot_started", {
      mode: "webhook",
      webhook_domain: WEBHOOK_DOMAIN,
      webhook_path: WEBHOOK_PATH,
      webhook_port: WEBHOOK_PORT,
      api_base_url: API_BASE_URL,
    });
    return;
  }

  await bot.launch();
  log("info", "bot_started", { mode: "polling", api_base_url: API_BASE_URL });
}

launch().catch((err) => {
  log("error", "bot_start_failed", { message: err.message });
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
