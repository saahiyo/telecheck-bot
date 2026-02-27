require("dotenv").config();

const axios = require("axios");
const { Telegraf } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_BASE_URL = process.env.API_BASE_URL || "https://telecheck.vercel.app";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);
const BULK_REPLY_PROMPT = "Reply to this message with all links to validate (space/newline separated).";

if (!BOT_TOKEN) {
  throw new Error("Missing BOT_TOKEN in environment.");
}

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: REQUEST_TIMEOUT_MS,
});

const bot = new Telegraf(BOT_TOKEN);
const URL_REGEX = /(https?:\/\/[^\s,]+|t\.me\/[^\s,]+)/g;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function pick(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
      return obj[key];
    }
  }
  return undefined;
}

function normalizeStatus(value) {
  if (!value) return "unknown";
  const s = String(value).toLowerCase();
  if (["valid", "ok", "alive", "active", "true"].includes(s)) return "valid";
  if (["invalid", "bad", "dead", "false"].includes(s)) return "invalid";
  return "unknown";
}

function normalizeResult(item) {
  const link = pick(item, ["link", "url", "input", "username", "value"]) || "(unknown link)";
  const statusRaw = pick(item, ["status", "result", "state", "validity", "type"]);
  const reason = pick(item, ["reason", "error", "message", "details"]);
  const status = normalizeStatus(statusRaw);
  return { link: String(link), status, reason: reason ? String(reason) : null };
}

function formatOne(result) {
  const icon = result.status === "valid" ? "[VALID]" : result.status === "invalid" ? "[INVALID]" : "[UNKNOWN]";
  let out = `${icon} <b>${escapeHtml(result.status.toUpperCase())}</b>\n`;
  out += `LINK: <code>${escapeHtml(result.link)}</code>`;
  return out;
}

function extractUrls(text) {
  return (String(text).match(URL_REGEX) || []).map((l) => l.trim());
}

function deduplicateLinks(links) {
  const seen = new Set();
  const unique = [];
  for (const link of links) {
    if (seen.has(link)) continue;
    seen.add(link);
    unique.push(link);
  }
  return unique;
}

async function replyInChunks(ctx, lines, maxLen = 3500) {
  const chunks = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLen && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

async function checkSingle(link) {
  const { data } = await api.get("/", { params: { link } });
  return normalizeResult({ ...(data || {}), link });
}

function extractBulkRows(data, requestedLinks) {
  if (Array.isArray(data)) return data;

  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;

  const validList = Array.isArray(data?.valid) ? data.valid : null;
  const invalidList = Array.isArray(data?.invalid) ? data.invalid : null;
  const unknownList = Array.isArray(data?.unknown) ? data.unknown : null;
  if (validList || invalidList || unknownList) {
    const rows = [];
    for (const link of validList || []) rows.push({ link, status: "valid" });
    for (const link of invalidList || []) rows.push({ link, status: "invalid" });
    for (const link of unknownList || []) rows.push({ link, status: "unknown" });
    if (rows.length > 0) return rows;
  }

  if (data && typeof data === "object") {
    const keys = Object.keys(data);
    const mapLike = keys.length > 0 && keys.every((k) => typeof data[k] !== "function");
    if (mapLike) {
      const byLinkRows = [];
      for (const key of keys) {
        const value = data[key];
        if (requestedLinks.includes(key)) {
          if (typeof value === "string") byLinkRows.push({ link: key, status: value });
          else if (value && typeof value === "object") byLinkRows.push({ link: key, ...value });
        }
      }
      if (byLinkRows.length > 0) return byLinkRows;
    }
  }

  return null;
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
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      const { data } = await attempt();
      const rows = extractBulkRows(data, links);

      if (!rows) {
        continue;
      }

      const normalized = rows.map(normalizeResult);
      if (normalized.length === links.length) return normalized;
      if (normalized.length > 0) {
        const byLink = new Map(normalized.map((r) => [r.link, r]));
        return links.map((link) => byLink.get(link) || normalizeResult({ link, status: "unknown", reason: "Missing in bulk response" }));
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) {
    // If bulk endpoint is unstable, fallback to reliable single checks.
    return checkBulkFallback(links);
  }
  return checkBulkFallback(links);
}

async function getStats() {
  const { data } = await api.get("/stats");
  const total = pick(data, ["total", "totalChecked", "checked", "all", "count"]);
  const valid = pick(data, ["valid", "validCount", "ok"]);
  const invalid = pick(data, ["invalid", "invalidCount", "bad"]);
  const unknown = pick(data, ["unknown", "unknownCount"]);
  return { total, valid, invalid, unknown, raw: data };
}

bot.start((ctx) => {
  return ctx.replyWithHTML(
    [
      "<b>TeleCheck Bot</b>",
      "",
      "Check Telegram links using telecheck.vercel.app.",
      "",
      "Commands:",
      "/check &lt;link&gt; - check one link",
      "/bulk - reply to this command with multiple links",
      "/stats - show API stats",
      "/help - usage guide",
    ].join("\n")
  );
});

bot.help((ctx) => {
  return ctx.reply(
    [
      "Usage:",
      "1) /check https://t.me/example",
      "2) Send multiple links in one message (space or newline separated)",
      "3) /stats",
    ].join("\n")
  );
});

bot.command("stats", async (ctx) => {
  try {
    const stats = await getStats();
    const lines = ["TeleCheck API Stats"];

    if (stats.total !== undefined) lines.push(`Total: ${stats.total}`);
    if (stats.valid !== undefined) lines.push(`Valid: ${stats.valid}`);
    if (stats.invalid !== undefined) lines.push(`Invalid: ${stats.invalid}`);
    if (stats.unknown !== undefined) lines.push(`Unknown: ${stats.unknown}`);

    if (lines.length === 1) {
      lines.push(JSON.stringify(stats.raw));
    }

    await ctx.reply(lines.join("\n"));
  } catch (err) {
    await ctx.reply(`Failed to fetch stats: ${err.message}`);
  }
});

bot.command("check", async (ctx) => {
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
    await ctx.reply(`Check failed: ${err.message}`);
  }
});

bot.command("bulk", async (ctx) => {
  await ctx.reply(BULK_REPLY_PROMPT);
});

bot.on("text", async (ctx) => {
  const text = (ctx.message.text || "").trim();
  const reply = ctx.message.reply_to_message;
  const isBulkReply =
    Boolean(reply?.from?.is_bot) &&
    typeof reply?.text === "string" &&
    reply.text.includes(BULK_REPLY_PROMPT);

  if (!text || text.startsWith("/")) return;

  const links = deduplicateLinks(extractUrls(text));
  if (links.length === 0) return;
  if (links.length > 1 && !isBulkReply) return;

  if (links.length === 1) {
    try {
      const result = await checkSingle(links[0]);
      await ctx.replyWithHTML(formatOne(result));
    } catch (err) {
      await ctx.reply(`Check failed: ${err.message}`);
    }
    return;
  }

  await ctx.reply(`Checking ${links.length} links...`);

  try {
    const results = await checkBulk(links);
    const summary = {
      valid: results.filter((r) => r.status === "valid").length,
      invalid: results.filter((r) => r.status === "invalid").length,
      unknown: results.filter((r) => r.status === "unknown").length,
    };
    const statusRank = { valid: 0, invalid: 1, unknown: 2 };
    const orderedResults = [...results].sort(
      (a, b) => (statusRank[a.status] ?? 99) - (statusRank[b.status] ?? 99)
    );

    const lines = [
      `Done. Total: ${results.length}`,
      `Valid: ${summary.valid}`,
      `Invalid: ${summary.invalid}`,
      `Unknown: ${summary.unknown}`,
      "",
      ...orderedResults.map((r) => {
        const icon = r.status === "valid" ? "[V]" : r.status === "invalid" ? "[X]" : "[?]";
        return `${icon} ${r.link}`;
      }),
    ];
    await replyInChunks(ctx, lines);
  } catch (err) {
    await ctx.reply(`Bulk check failed: ${err.message}`);
  }
});

bot.catch((err, ctx) => {
  console.error("Bot error:", err);
  if (ctx) {
    ctx.reply("Unexpected error occurred.").catch(() => {});
  }
});

bot.launch().then(() => {
  console.log(`TeleCheck bot is running. API: ${API_BASE_URL}`);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));


