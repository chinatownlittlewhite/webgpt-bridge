const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const renderer = fs.readFileSync(path.join(root, "src", "renderer", "renderer.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "src", "preload.cjs"), "utf8");
const ipc = fs.readFileSync(path.join(root, "src", "host", "ipc-controller.cjs"), "utf8");
const main = fs.readFileSync(path.join(root, "src", "main.cjs"), "utf8");

test("renderer requests logs incrementally by cursor and reacts to Host reset", () => {
  assert.match(renderer, /let\s+logCursor\s*=\s*0/);
  assert.match(renderer, /api\.logs\(\{\s*sinceCursor:\s*logCursor\s*\}\)/);
  assert.match(renderer, /batch\.reset/);
  assert.match(renderer, /entry\.cursor\s*>\s*logCursor/);
  assert.doesNotMatch(renderer, /event\.type\s*===\s*["']logs["']\)\s*renderLogs\(event\.value\)/);
});

test("preload and IPC keep the cursor request bounded", () => {
  assert.match(preload, /logs:\s*\(options\s*=\s*\{\}\)\s*=>\s*ipcRenderer\.invoke\(["']host:logs["'],\s*options\)/);
  assert.match(ipc, /host:logs["'][\s\S]{0,120}getLogs\(payload\)/);
});

test("Host composition root delegates log retention to log-stream-service", () => {
  assert.match(main, /createLogStreamService/);
  assert.doesNotMatch(main, /logLines\.push\(/);
  assert.doesNotMatch(main, /logLines\.slice\(/);
  assert.match(main, /emit\(["']logs["'],\s*\{\s*cursor:/);
});
