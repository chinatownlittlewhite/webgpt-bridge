const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(root, "src", "renderer", "styles.css"), "utf8");

test("command-centred renderer styles primary operational regions", () => {
  for (const selector of ["#commandBar", "#goalStrip", "#activeTask", "#activityLog", "#diagnosticStrip"]) {
    assert.match(css, new RegExp(selector.replace("#", "\\#")), `missing styles for ${selector}`);
  }
});

test("renderer has an explicit narrow viewport layout", () => {
  assert.match(css, /@media\s*\([^)]*max-width\s*:\s*(?:7\d\d|6\d\d|5\d\d)px[^)]*\)/);
  assert.match(css, /#commandBar[\s\S]*?(?:grid-template-columns|flex-direction)/);
});

test("activity log is bounded rather than expanding the whole page", () => {
  const activityRule = css.match(/#activityLog\s*\{([^}]*)\}/s);
  assert.ok(activityRule, "missing #activityLog rule");
  assert.match(activityRule[1], /(?:max-height|block-size|height)\s*:/);
  assert.match(activityRule[1], /overflow(?:-y)?\s*:\s*(?:auto|scroll)/);
});
