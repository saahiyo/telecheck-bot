const test = require("node:test");
const assert = require("node:assert/strict");
const { extractUrls, deduplicateLinks, buildBulkLines, chunkLines, normalizeStatus } = require("../src/core");

test("extractUrls matches telegram and http links", () => {
  const input = "x t.me/a https://t.me/b https://example.com, end";
  const out = extractUrls(input);
  assert.deepEqual(out, ["t.me/a", "https://t.me/b", "https://example.com"]);
});

test("deduplicateLinks preserves order", () => {
  const out = deduplicateLinks(["a", "b", "a", "c", "b"]);
  assert.deepEqual(out, ["a", "b", "c"]);
});

test("normalizeStatus maps known states", () => {
  assert.equal(normalizeStatus("active"), "valid");
  assert.equal(normalizeStatus("dead"), "invalid");
  assert.equal(normalizeStatus("something-else"), "unknown");
});

test("buildBulkLines puts valid first and includes summary", () => {
  const results = [
    { link: "l1", status: "unknown" },
    { link: "l2", status: "invalid" },
    { link: "l3", status: "valid" },
  ];
  const lines = buildBulkLines(results);
  assert.equal(lines[0], "Done. Total: 3");
  assert.equal(lines[1], "Valid: 1");
  assert.equal(lines[2], "Invalid: 1");
  assert.equal(lines[3], "Unknown: 1");
  assert.equal(lines[5], "[V] l3");
  assert.equal(lines[6], "[X] l2");
  assert.equal(lines[7], "[?] l1");
});

test("chunkLines splits output safely", () => {
  const lines = ["12345", "67890", "abcde"];
  const chunks = chunkLines(lines, 11);
  assert.deepEqual(chunks, ["12345\n67890", "abcde"]);
});
