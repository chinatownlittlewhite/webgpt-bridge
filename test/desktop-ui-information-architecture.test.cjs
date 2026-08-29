const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8").replace(/\r\n/g, "\n");
const css = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8").replace(/\r\n/g, "\n");

const preservedIds = [
  "connection", "start", "stop", "openChatGPT", "workspacePath", "tunnelId", "runtimeKey", "clearKey",
  "save", "serverState", "tunnelState", "nextStep", "updateHeadline", "updateCurrentVersion", "updateAction",
  "updateNotes", "updateProgress", "updateProgressBar", "updateMeta", "approvalMode", "designIssueJournal",
  "sshEnabled", "sshAllowedHosts", "runtimePath", "tunnelClientPath", "nodePath", "profile", "httpsProxy",
  "logOutput", "message",
];

function countId(id) {
  return (html.match(new RegExp(`\\bid=["']${id}["']`, "g")) || []).length;
}

test("desktop UI follows the approved five-section information architecture in order", () => {
  const sectionIds = ["overview", "workspace", "permissions", "advanced", "diagnostics"];
  let previous = -1;
  for (const id of sectionIds) {
    const marker = `id="${id}"`;
    const position = html.indexOf(marker);
    assert.ok(position > previous, `${id} must exist after the previous approved section`);
    previous = position;
    assert.match(html, new RegExp(`href=["']#${id}["']`), `${id} must be keyboard-navigable from section navigation`);
  }
  assert.match(html, /<nav\b[^>]*aria-label=["'][^"']+["']/);
});

test("desktop UI preserves existing renderer control IDs while reorganizing the surface", () => {
  for (const id of preservedIds) assert.equal(countId(id), 1, `${id} must remain unique for renderer IPC wiring`);
  assert.doesNotMatch(html, /<link\b[^>]+href=["']https?:\/\//i);
  assert.doesNotMatch(html, /<script\b[^>]+src=["']https?:\/\//i);
});

test("permissions section exposes the approved capability matrix and immutable safety boundaries", () => {
  for (const capability of [
    "workspace-files", "host-files", "network", "remote-write", "sensitive-files", "shell",
    "privilege-escalation", "sandbox-expansion",
  ]) {
    assert.match(html, new RegExp(`data-capability=["']${capability}["']`), `missing capability row ${capability}`);
  }
  for (const capability of ["shell", "privilege-escalation", "sandbox-expansion"]) {
    assert.match(
      html,
      new RegExp(`data-capability=["']${capability}["'][^>]*data-policy=["']immutable-deny["']|data-policy=["']immutable-deny["'][^>]*data-capability=["']${capability}["']`),
      `${capability} must remain visibly immutable`,
    );
  }
  assert.match(html, /value=["']full_control["'][^>]*>[^<]*(?:安全边界|边界)/);
  assert.doesNotMatch(html, /value=["']full_control["'][^>]*>\s*完全控制（无确认）/);
});

test("desktop visual system provides explicit keyboard focus, reduced motion, and narrow-window fallbacks", () => {
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /@media\s*\(max-width:\s*610px\)/);
  assert.doesNotMatch(css, /@media\s*\(max-width:[^)]+\)[\s\S]*?(?:button|input|select)[^{]*\{[^}]*display:\s*none/i);
});
