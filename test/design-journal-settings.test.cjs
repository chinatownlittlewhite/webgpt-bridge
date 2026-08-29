const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { normalizeSettings } = require("../src/host-config.cjs");

test("design issue journal setting defaults off and persists only a boolean", () => {
  assert.equal(normalizeSettings({}).designIssueJournal, false);
  assert.equal(normalizeSettings({ designIssueJournal: true }).designIssueJournal, true);
  assert.equal(normalizeSettings({ designIssueJournal: "true" }).designIssueJournal, false);
});

test("desktop settings expose the design issue journal toggle and pass it to the Agent", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "src", "renderer", "index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "src", "renderer", "renderer.js"), "utf8");
  const runtimeHost = fs.readFileSync(path.join(root, "src", "host", "runtime-host.cjs"), "utf8");
  assert.match(html, /id="designIssueJournal"/);
  assert.match(renderer, /designIssueJournal/);
  assert.match(runtimeHost, /LPC_DESIGN_ISSUE_JOURNAL/);
});
