const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createWindowController } = require("../src/host/window-controller.cjs");

class FakeWebContents extends EventEmitter {
  setWindowOpenHandler() {}
}

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.webContents = new FakeWebContents();
    this.calls = [];
    this.minimized = false;
    this.destroyed = false;
  }

  isDestroyed() { return this.destroyed; }
  isMinimized() { return this.minimized; }
  restore() { this.calls.push("restore"); this.minimized = false; }
  show() { this.calls.push("show"); }
  focus() { this.calls.push("focus"); }
  hide() { this.calls.push("hide"); }
  loadFile() {}
}

test("showWindow restores a minimized primary window before showing and focusing it", () => {
  let window;
  class BrowserWindow extends FakeWindow {
    constructor() {
      super();
      window = this;
    }
  }

  const controller = createWindowController({
    BrowserWindow,
    shell: { openExternal() {} },
    preloadPath: "/tmp/preload.cjs",
    rendererPath: "/tmp/index.html",
    platform: "linux",
    nativeQuitAllowed: () => false,
  });

  controller.createWindow();
  window.minimized = true;
  window.calls.length = 0;

  assert.equal(controller.showWindow(), window);
  assert.deepEqual(window.calls, ["restore", "show", "focus"]);
});
