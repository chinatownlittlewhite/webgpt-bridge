const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("Windows installer registers a fixed XML task definition without /TR quote parsing", () => {
  const taskXmlPath = path.join(root, "build", "windows-host-prep-task.xml");
  assert.equal(fs.existsSync(taskXmlPath), true, "fixed scheduled-task XML must exist in build resources");

  const xml = fs.readFileSync(taskXmlPath, "utf8");
  const installer = fs.readFileSync(path.join(root, "build", "installer.nsh"), "utf8");
  const builder = fs.readFileSync(path.join(root, "build", "electron-builder-options.cjs"), "utf8");

  assert.doesNotMatch(xml, /<\?xml[^?]*\bencoding\s*=/i, "schtasks /XML must auto-detect the packaged XML bytes instead of switching encodings");
  assert.match(xml, /<BootTrigger>[\s\S]*<Enabled>true<\/Enabled>[\s\S]*<\/BootTrigger>/);
  assert.match(xml, /<UserId>S-1-5-18<\/UserId>/);
  assert.match(xml, /<RunLevel>HighestAvailable<\/RunLevel>/);
  assert.match(xml, /<Command>%ProgramFiles%\\WebGPT Bridge\\resources\\app\.asar\.unpacked\\agent-runtime\\native\\windows-host-prep\\bin\\release\\lpc-windows-host-prep\.exe<\/Command>/);
  assert.match(xml, /<Arguments>--apply<\/Arguments>/);

  assert.match(builder, /windows-host-prep-task\.xml/);
  assert.match(installer, /schtasks\.exe[\s\S]*\/Create[\s\S]*\/XML[\s\S]*windows-host-prep-task\.xml/);
  assert.doesNotMatch(installer, /\/TR\s/);
});
