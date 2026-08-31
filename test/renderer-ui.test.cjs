const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src", "renderer", "index.html"), "utf8");

function indexOfId(id) {
  return html.indexOf(`id="${id}"`);
}

test("renderer exposes the command-centred v0.5 primary regions", () => {
  for (const id of ["commandBar", "goalStrip", "activeTask", "activityLog", "diagnosticStrip"]) {
    assert.ok(indexOfId(id) >= 0, `missing primary renderer region #${id}`);
  }
});

test("command and active work precede settings in visual source order", () => {
  const command = indexOfId("commandBar");
  const goal = indexOfId("goalStrip");
  const task = indexOfId("activeTask");
  const settings = html.indexOf("id=\"advancedSettings\"");
  assert.ok(command >= 0 && goal > command && task > goal, "primary work regions must be ordered command -> goal -> task");
  assert.ok(settings > task, "advanced settings must be secondary to active work");
});

test("renderer no longer uses the marketing hero as the primary controller", () => {
  assert.doesNotMatch(html, /class="controller card hero-card"/);
  assert.doesNotMatch(html, /把本地开发能力，<br \/>安全交给 ChatGPT/);
});

test("advanced settings remain reachable but collapsed by default", () => {
  assert.match(html, /<details[^>]+id="advancedSettings"[^>]*>/);
  assert.doesNotMatch(html, /<details[^>]+id="advancedSettings"[^>]*\sopen(?:\s|>)/);
});
