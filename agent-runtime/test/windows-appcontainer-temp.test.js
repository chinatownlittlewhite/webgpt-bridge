import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("Windows helper initializes only the workspace-local AppContainer temp before launch", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "..", "native", "windows-sandbox", "Program.cs"), "utf8");
  assert.match(source, /EnsureAppContainerTemp\(profileName, workspace\);/);
  assert.match(source, /private static void EnsureAppContainerTemp\(string profileName, string workspace\)/);
  assert.match(source, /Environment\.GetEnvironmentVariable\("LOCALAPPDATA"\)/);
  assert.match(source, /if \(!IsInside\(workspace, localAppData\)\)/);
  assert.match(source, /Path\.Combine\(localAppData, "Packages", profileName, "AC", "Temp"\)/);
  assert.match(source, /Directory\.CreateDirectory\(temp\);/);
});
