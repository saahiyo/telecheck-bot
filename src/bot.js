require("dotenv").config();

const axios = require("axios");
const { Telegraf } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_BASE_URL = process.env.API_BASE_URL || "https://telecheck.vercel.app";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);

if (!BOT_TOKEN) {
  throw new Error("Missing BOT_TOKEN in environment.");
}

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: REQUEST_TIMEOUT_MS,
});

const bot = new Telegraf(BOT_TOKEN);

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
  if (result.reason) out += `\n?? ${escapeHtml(result.reason)}`;
  return out;
}

function splitLinks(text) {
  return String(text)
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function checkSingle(link) {
  const { data } = await api.get("/", { params: { link } });
  return normalizeResult(data);
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
      const rows = Array.isArray(data)
        ? data
        : Array.isArray(data?.results)
        ? data.results
        : Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.items)
        ? data.items
        : null;

      if (!rows) {
        return links.map((link) => normalizeResult({ link, status: "unknown", reason: "Unexpected bulk response format" }));
      }

      return rows.map(normalizeResult);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError;
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
  const link = text.replace(/^\/check(@\w+)?\s*/i, "").trim();

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
  await ctx.reply("Send links in your next message (space/newline separated). I will validate all of them.");
});

bot.on("text", async (ctx) => {
  const text = (ctx.message.text || "").trim();

  if (!text || text.startsWith("/")) return;

  const links = splitLinks(text);
  if (links.length === 0) return;

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

    const lines = [
      `Done. Total: ${results.length}`,
      `Valid: ${summary.valid}`,
      `Invalid: ${summary.invalid}`,
      `Unknown: ${summary.unknown}`,
      "",
      ...results.slice(0, 30).map((r) => {
        const icon = r.status === "valid" ? "[V]" : r.status === "invalid" ? "[X]" : "[?]";
        return `${icon} ${r.link}${r.reason ? ` (${r.reason})` : ""}`;
      }),
    ];

    if (results.length > 30) {
      lines.push("", `Showing first 30 of ${results.length} results.`);
    }

    await ctx.reply(lines.join("\n"));
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


