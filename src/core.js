"use strict";

const URL_REGEX = /(https?:\/\/[^\s,]+|t\.me\/[^\s,]+)/g;

function pick(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") return obj[key];
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

function extractUrls(text) {
  return (String(text).match(URL_REGEX) || []).map((v) => v.trim());
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
    const byLinkRows = [];
    for (const key of keys) {
      const value = data[key];
      if (!requestedLinks.includes(key)) continue;
      if (typeof value === "string") byLinkRows.push({ link: key, status: value });
      else if (value && typeof value === "object") byLinkRows.push({ link: key, ...value });
    }
    if (byLinkRows.length > 0) return byLinkRows;
  }

  return null;
}

function orderResults(results) {
  const rank = { valid: 0, invalid: 1, unknown: 2 };
  return [...results].sort((a, b) => (rank[a.status] ?? 99) - (rank[b.status] ?? 99));
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildBulkLines(results, options = {}) {
  const showInvalid = options.showInvalid !== false;
  const validLinks = results.filter((r) => r.status === "valid");
  const invalidLinks = results.filter((r) => r.status === "invalid");
  const unknownLinks = results.filter((r) => r.status === "unknown");

  const lines = [
    `<b>Done. Total: ${results.length}</b>`,
    `Valid: ${validLinks.length}  Invalid: ${invalidLinks.length}  Unknown: ${unknownLinks.length}`,
    "",
  ];

  if (validLinks.length > 0) {
    lines.push(`<b>Valid Links</b>`);
    lines.push(`─────────────────`);
    validLinks.forEach((r, i) => {
      lines.push(`${i + 1}. ${escapeHtml(r.link)}`);
    });
    lines.push("");
  }

  if (showInvalid && invalidLinks.length > 0) {
    lines.push(`<b>Invalid Links</b>`);
    lines.push(`─────────────────`);
    invalidLinks.forEach((r, i) => {
      lines.push(`${i + 1}. ${escapeHtml(r.link)}`);
    });
    lines.push("");
  }

  if (unknownLinks.length > 0) {
    lines.push(`<b>Unknown Links</b>`);
    lines.push(`─────────────────`);
    unknownLinks.forEach((r, i) => {
      lines.push(`${i + 1}. ${escapeHtml(r.link)}`);
    });
    lines.push("");
  }

  return lines;
}

function chunkLines(lines, maxLen = 3500) {
  const chunks = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLen && current) {
      chunks.push(current);
      current = line;
      continue;
    }
    current = next;
  }
  if (current) chunks.push(current);
  return chunks;
}

module.exports = {
  URL_REGEX,
  pick,
  normalizeStatus,
  normalizeResult,
  extractUrls,
  deduplicateLinks,
  extractBulkRows,
  orderResults,
  buildBulkLines,
  chunkLines,
};
