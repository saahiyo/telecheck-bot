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
const BULK_REPLY_PROMPT = "📝 <b>Reply to this message</b> with all links to validate (space/newline separated).";

const MAX_MESSAGE_CHARS = Number(process.env.MAX_MESSAGE_CHARS || 12000);
const MAX_LINKS_PER_BULK = Number(process.env.MAX_LINKS_PER_BULK || 300);
const REPLY_CHUNK_MAX_LEN = Number(process.env.REPLY_CHUNK_MAX_LEN || 3500);
const RETRY_ATTEMPTS = Number(process.env.RETRY_ATTEMPTS || 3);
const RETRY_BASE_DELAY_MS = Number(process.env.RETRY_BASE_DELAY_MS || 400);
const PROCESSED_DELETE_MS = Number(process.env.PROCESSED_DELETE_MS || 5 * 60 * 1000);
const PROCESSED_WARNING_TEXT = '⏳ <i>Save these messages, they will automatically get deleted after 5 minutes.</i>';
const AUTH_PASSWORD = String(process.env.AUTH_PASSWORD || "").trim();
const AUTH_STORE_FILE = process.env.AUTH_STORE_FILE || "./data/auth-users.json";
const USER_PREFS_STORE_FILE = process.env.USER_PREFS_STORE_FILE || "./data/user-settings.json";
const STATS_STORE_FILE = process.env.STATS_STORE_FILE || "./data/global-stats.json";
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

const authenticatedUsers = new Set();
const authStorePath = path.isAbsolute(AUTH_STORE_FILE) ? AUTH_STORE_FILE : path.resolve(process.cwd(), AUTH_STORE_FILE);
const userPrefs = new Map();
const userPrefsStorePath = path.isAbsolute(USER_PREFS_STORE_FILE) ? USER_PREFS_STORE_FILE : path.resolve(process.cwd(), USER_PREFS_STORE_FILE);
const statsStorePath = path.isAbsolute(STATS_STORE_FILE) ? STATS_STORE_FILE : path.resolve(process.cwd(), STATS_STORE_FILE);
const globalStats = { totalProcessed: 0, totalValid: 0, totalInvalid: 0, totalUnknown: 0 };

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
  return /^(\/(start|help|auth)(@\w+)?(\s|$)|(start|help|auth)\s*$)/i.test(String(text || ""));
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
  rows.push(["🔍 Check", "📦 Bulk Check"]);
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

async function loadGlobalStats() {
  try {
    const raw = await fsp.readFile(statsStorePath, "utf8");
    const parsed = JSON.parse(raw);
    globalStats.totalProcessed = Number(parsed.totalProcessed) || 0;
    globalStats.totalValid = Number(parsed.totalValid) || 0;
    globalStats.totalInvalid = Number(parsed.totalInvalid) || 0;
    globalStats.totalUnknown = Number(parsed.totalUnknown) || 0;
    log("info", "global_stats_loaded", { file: statsStorePath, ...globalStats });
  } catch (err) {
    if (err?.code === "ENOENT") {
      log("info", "global_stats_not_found", { file: statsStorePath });
      return;
    }
    log("error", "global_stats_load_failed", { file: statsStorePath, message: err.message });
  }
}

async function persistGlobalStats() {
  const dir = path.dirname(statsStorePath);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(statsStorePath, `${JSON.stringify(globalStats, null, 2)}\n`, "utf8");
}

function trackResult(result) {
  globalStats.totalProcessed++;
  if (result.status === "valid") globalStats.totalValid++;
  else if (result.status === "invalid") globalStats.totalInvalid++;
  else globalStats.totalUnknown++;
}

async function trackResults(results) {
  for (const r of Array.isArray(results) ? results : [results]) {
    trackResult(r);
  }
  await persistGlobalStats().catch((err) => {
    log("error", "global_stats_persist_failed", { message: err.message });
  });
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

// Rate limiting removed — all requests allowed.

function formatOne(result) {
  const icon = result.status === "valid" ? "✅ [VALID]" : result.status === "invalid" ? "❌ [INVALID]" : "❓ [UNKNOWN]";
  return `${icon} <b>${escapeHtml(result.status.toUpperCase())}</b>\n🔗 LINK: <code>${escapeHtml(result.link)}</code>`;
}

async function cleanupOriginalMessage(ctx) {
  if (ctx?.message?.message_id && ctx?.chat?.id) {
    scheduleDelete(ctx.telegram, ctx.chat.id, ctx.message.message_id);
  }
}

async function sendProcessedWarning(ctx) {
  await ctx.replyWithHTML(PROCESSED_WARNING_TEXT);
}

async function replyInChunks(ctx, lines) {
  const chunks = chunkLines(lines, REPLY_CHUNK_MAX_LEN);
  const messageIds = [];
  for (const chunk of chunks) {
    const msg = await ctx.replyWithHTML(chunk);
    if (msg?.message_id) messageIds.push(msg.message_id);
  }
  return messageIds;
}

async function checkSingle(link) {
  const { data } = await withRetry(() => api.get("/", { params: { link } }), "single");
  const result = normalizeResult({ ...(data || {}), link });
  await trackResults(result);
  return result;
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
    await ctx.reply("🚫 <b>This chat is not allowed to use this bot.</b>", { parse_mode: "HTML" });
    return false;
  }
  const text = String(ctx?.message?.text || "");
  if (!isAuthenticated(ctx) && !isAuthExemptMessage(text)) {
    await ctx.reply("🔒 <b>Password required.</b> Use /auth &lt;password&gt;.", { parse_mode: "HTML", ...mainKeyboard(ctx) });
    return false;
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    await ctx.reply(`⚠️ <b>Message too large.</b> Max characters allowed: ${MAX_MESSAGE_CHARS}.`, { parse_mode: "HTML" });
    return false;
  }
  return true;
}

bot.start(async (ctx) => {
  if (!(await guard(ctx))) return;
  return ctx.replyWithHTML(
    [
      "🤖 <b>TeleCheck Bot</b>",
      "",
      "<b>Commands:</b>",
      "🔍 /check &lt;link&gt; - check one link",
      "📦 /bulk - request bulk mode prompt",
      "🔒 /auth &lt;password&gt; - authenticate this account",
      "⚙️ /invalid &lt;on|off&gt; - show/hide invalid links in bulk output",
      "📊 /stats - show API stats",
      "🏥 /health - runtime health",
      "ℹ️ /help - usage guide",
    ].join("\n"),
    mainKeyboard(ctx)
  );
});

bot.help(async (ctx) => {
  if (!(await guard(ctx))) return;
  return ctx.replyWithHTML(
    [
      "📖 <b>Usage:</b>",
      "🔐 0) /auth &lt;password&gt; (if password auth is enabled)",
      "🔍 1) /check https://t.me/example",
      "📦 2) /bulk then reply to prompt with many links",
      "📊 3) /stats",
      "⚙️ 4) /invalid on|off (bulk output preference)",
      "",
      `⚠️ <i>Limits: ${MAX_LINKS_PER_BULK} links per bulk request.</i>`,
    ].join("\n"),
    mainKeyboard(ctx)
  );
});

bot.command("auth", async (ctx) => {
  if (!isAllowedChat(ctx)) {
    await ctx.reply("🚫 <b>This chat is not allowed to use this bot.</b>", { parse_mode: "HTML" });
    return;
  }
  if (!hasPasswordAuth()) {
    await ctx.reply("⚠️ <b>Password auth is not enabled.</b>", { parse_mode: "HTML", ...mainKeyboard(ctx) });
    return;
  }

  const text = String(ctx?.message?.text || "");
  const supplied = text.replace(/^\/auth(@\w+)?\s*/i, "").trim();
  if (!supplied) {
    await ctx.reply("📝 <b>Provide password.</b> Example: <code>/auth your_password</code>", { parse_mode: "HTML", ...mainKeyboard(ctx) });
    return;
  }
  if (supplied !== AUTH_PASSWORD) {
    await ctx.reply("❌ <b>Invalid password.</b>", { parse_mode: "HTML", ...mainKeyboard(ctx) });
    return;
  }

  const userId = Number(ctx?.from?.id);
  try {
    const added = await authenticateUser(userId);
    if (added) {
      log("info", "user_authenticated", { user_id: userId, total: authenticatedUsers.size });
      await ctx.reply("✅ <b>Authentication successful.</b>", { parse_mode: "HTML", ...mainKeyboard(ctx) });
      return;
    }
    await ctx.reply("ℹ️ <b>Already authenticated.</b>", { parse_mode: "HTML", ...mainKeyboard(ctx) });
  } catch (err) {
    log("error", "auth_store_persist_failed", { message: err.message });
    await ctx.reply("✅ <b>Authenticated for this run</b>, but failed to persist auth store.", { parse_mode: "HTML", ...mainKeyboard(ctx) });
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
      `rate_limit: none`,
    ].join("\n")
  );
});

bot.command("invalid", async (ctx) => {
  if (!(await guard(ctx))) return;
  const text = String(ctx?.message?.text || "");
  const input = text.replace(/^\/invalid(@\w+)?\s*/i, "").trim().toLowerCase();

  if (!input) {
    const showInvalid = shouldShowInvalidBulkForCtx(ctx);
    await ctx.replyWithHTML(
      `⚙️ <b>Invalid links in bulk output:</b> ${showInvalid ? "🟢 ON" : "🔴 OFF"}\n<i>Use: /invalid on or /invalid off</i>`,
      mainKeyboard(ctx)
    );
    return;
  }

  let nextValue;
  if (["on", "show", "true", "yes", "1"].includes(input)) nextValue = true;
  else if (["off", "hide", "false", "no", "0"].includes(input)) nextValue = false;
  else {
    await ctx.replyWithHTML("❌ <b>Invalid value.</b> Use: <code>/invalid on</code> or <code>/invalid off</code>", mainKeyboard(ctx));
    return;
  }

  try {
    await setShowInvalidBulk(ctx?.from?.id, nextValue);
    await ctx.replyWithHTML(
      `✅ <b>Updated:</b> invalid links in bulk output are now ${nextValue ? "🟢 <b>ON</b>" : "🔴 <b>OFF</b>"}.`,
      mainKeyboard(ctx)
    );
  } catch (err) {
    log("error", "user_prefs_store_persist_failed", { message: err.message });
    await ctx.replyWithHTML("❌ <b>Failed to save setting.</b>", mainKeyboard(ctx));
  }
});

bot.command("stats", async (ctx) => {
  if (!(await guard(ctx))) return;
  const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
  const lines = [
    "📊 <b>TeleCheck Bot Stats</b>",
    "─────────────────",
    `🔹 <b>Total Processed:</b> ${globalStats.totalProcessed}`,
    `✅ <b>Valid:</b> ${globalStats.totalValid}`,
    `❌ <b>Invalid:</b> ${globalStats.totalInvalid}`,
    `❓ <b>Unknown:</b> ${globalStats.totalUnknown}`,
    "",
    `👤 <b>Authenticated Users:</b> ${authenticatedUsers.size}`,
    `⏱ <b>Uptime:</b> ${uptimeSec}s`,
  ];
  await ctx.replyWithHTML(lines.join("\n"));
});

bot.command("check", async (ctx) => {
  if (!(await guard(ctx))) return;
  const text = ctx.message.text || "";
  const input = text.replace(/^\/check(@\w+)?\s*/i, "").trim();
  const link = extractUrls(input)[0] || input;
  if (!link) {
    await ctx.replyWithHTML("📝 <b>Provide a link.</b> Example: <code>/check https://t.me/example</code>");
    return;
  }

  await cleanupOriginalMessage(ctx);

  try {
    const result = await checkSingle(link);
    const msg = await ctx.replyWithHTML(formatOne(result));
    await sendProcessedWarning(ctx);
    if (msg?.message_id) scheduleDelete(ctx.telegram, ctx.chat.id, msg.message_id);
  } catch (err) {
    log("error", "single_failed", { message: err.message });
    await ctx.replyWithHTML("❌ <b>Check failed.</b>");
  }
});

bot.command("bulk", async (ctx) => {
  if (!(await guard(ctx))) return;
  await ctx.replyWithHTML(BULK_REPLY_PROMPT);
});

bot.on("text", async (ctx) => {
  const text = (ctx.message.text || "").trim();
  if (!(await guard(ctx))) return;
  const normalizedText = text.toLowerCase();
  if (!text) return;

  if (normalizedText === "check" || normalizedText === "🔍 check") {
    await ctx.replyWithHTML("📝 <b>Send one link to check</b>, or use: <code>/check &lt;link&gt;</code>");
    return;
  }

  if (normalizedText === "bulk check" || normalizedText === "📦 bulk check") {
    await ctx.replyWithHTML(BULK_REPLY_PROMPT);
    return;
  }

  await cleanupOriginalMessage(ctx);

  if (links.length === 1) {
    try {
      await ctx.sendChatAction("typing");
      const result = await checkSingle(links[0]);
      const msg = await ctx.replyWithHTML(formatOne(result));
      await sendProcessedWarning(ctx);
      if (msg?.message_id) scheduleDelete(ctx.telegram, ctx.chat.id, msg.message_id);
    } catch (err) {
      log("error", "single_text_failed", { message: err.message });
      await ctx.replyWithHTML("❌ <b>Check failed.</b>");
    }
    return;
  }

  const waitMsg = await ctx.replyWithHTML(`⏳ <b>Checking ${links.length} links...</b>`);
  try {
    await ctx.sendChatAction("typing");
    const results = await checkBulk(links);
    const lines = buildBulkLines(results, { showInvalid: shouldShowInvalidBulkForCtx(ctx) });
    const messageIds = await replyInChunks(ctx, lines);

    await sendProcessedWarning(ctx);
    scheduleDelete(ctx.telegram, ctx.chat.id, waitMsg.message_id);
    for (const id of messageIds) scheduleDelete(ctx.telegram, ctx.chat.id, id);
  } catch (err) {
    log("error", "bulk_failed", { message: err.message });
    await ctx.replyWithHTML("❌ <b>Bulk check failed.</b>");
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
  await loadGlobalStats();
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

