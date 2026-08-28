const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const helperPath = path.join(root, "scripts", "tunnel-client-download.cjs");
const launcherPath = path.join(root, "scripts", "launch-tunnel-client-prepare.cjs");

function loadDownloader() {
  assert.ok(fs.existsSync(helperPath), "tunnel-client downloader helper must exist");
  return require(helperPath);
}

function loadLauncher() {
  assert.ok(fs.existsSync(launcherPath), "tunnel-client prepare launcher must exist");
  return require(launcherPath);
}

function response(status, bytes = "ok") {
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() {
      return Buffer.from(bytes);
    },
  };
}

test("tunnel-client npm prepare scripts use the proxy-aware launcher", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["prepare:tunnel-client:mac"], "node scripts/launch-tunnel-client-prepare.cjs darwin-universal");
  assert.equal(pkg.scripts["prepare:tunnel-client:win"], "node scripts/launch-tunnel-client-prepare.cjs windows-amd64");
});

test("prepare launcher merges macOS system proxy only when environment proxy is absent", () => {
  const { resolvePrepareEnvironment, buildPrepareNodeArgs } = loadLauncher();
  const calls = [];
  const inherited = { PATH: "/bin", NO_PROXY: "internal.test" };
  const resolved = resolvePrepareEnvironment({
    platform: "darwin",
    env: inherited,
    resolveSystemProxy: () => {
      calls.push("system");
      return { HTTP_PROXY: "http://127.0.0.1:7890", HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "127.0.0.1,localhost" };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(resolved.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(resolved.NO_PROXY, "internal.test", "explicit environment values must win over system defaults");

  const explicit = resolvePrepareEnvironment({
    platform: "darwin",
    env: { HTTPS_PROXY: "http://explicit.test:8080" },
    resolveSystemProxy: () => assert.fail("system proxy must not be queried when HTTPS proxy is explicit"),
  });
  assert.equal(explicit.HTTPS_PROXY, "http://explicit.test:8080");

  const args = buildPrepareNodeArgs("darwin-universal");
  assert.equal(args[0], "--use-env-proxy");
  assert.equal(path.basename(args[1]), "prepare-tunnel-client.cjs");
  assert.equal(args[2], "darwin-universal");
});

test("downloader retries transient HTTP and network failures with bounded deterministic backoff", async () => {
  const { fetchBytesWithRetry } = loadDownloader();
  const attempts = [];
  const delays = [];
  const outcomes = [response(502), new Error("socket reset"), response(200, "payload")];
  const bytes = await fetchBytesWithRetry("https://example.test/tunnel.zip", {
    fetchImpl: async (url, options) => {
      attempts.push({ url, options });
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    sleep: async (ms) => { delays.push(ms); },
  });

  assert.equal(bytes.toString("utf8"), "payload");
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts.map((entry) => entry.options.redirect), ["follow", "follow", "follow"]);
  assert.ok(attempts.every((entry) => entry.options.signal instanceof AbortSignal), "every fetch attempt must carry an abort signal");
  assert.deepEqual(delays, [250, 750]);
});

test("downloader timeout keeps a standalone process alive until the stalled request is aborted", () => {
  const script = `
    const { fetchBytesWithRetry } = require(${JSON.stringify(helperPath)});
    fetchBytesWithRetry("https://example.test/stalled.zip", {
      fetchImpl: async (_url, options) => await new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason || new Error("aborted")), { once: true });
      }),
      sleep: async () => {},
      maxAttempts: 1,
      requestTimeoutMs: 10,
    }).then(
      () => { console.error("unexpected success"); process.exitCode = 2; },
      (error) => { console.log(error.message); if (!/timed out after 10 ms/i.test(error.message)) process.exitCode = 3; },
    );
  `;
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /timed out after 10 ms/i, "timeout must fire even when it is the only event-loop handle");
});

test("downloader aborts a stalled request after the bounded per-attempt timeout", async () => {
  const { fetchBytesWithRetry } = loadDownloader();
  let attempts = 0;
  await assert.rejects(() => fetchBytesWithRetry("https://example.test/stalled.zip", {
    fetchImpl: async (_url, options) => {
      attempts += 1;
      assert.ok(options.signal instanceof AbortSignal, "stalled request must receive an abort signal");
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason || new Error("aborted")), { once: true });
      });
    },
    sleep: async () => {},
    maxAttempts: 1,
    requestTimeoutMs: 10,
  }), /timed out after 10 ms/i);
  assert.equal(attempts, 1);
});

test("downloader never retries permanent HTTP failures and caps transient attempts", async () => {
  const { fetchBytesWithRetry } = loadDownloader();
  let permanentAttempts = 0;
  await assert.rejects(() => fetchBytesWithRetry("https://example.test/missing.zip", {
    fetchImpl: async () => { permanentAttempts += 1; return response(404); },
    sleep: async () => assert.fail("404 must not sleep or retry"),
  }), /Download failed \(404\)/);
  assert.equal(permanentAttempts, 1);

  let transientAttempts = 0;
  const delays = [];
  await assert.rejects(() => fetchBytesWithRetry("https://example.test/busy.zip", {
    fetchImpl: async () => { transientAttempts += 1; return response(503); },
    sleep: async (ms) => { delays.push(ms); },
  }), /after 4 attempts.*503/i);
  assert.equal(transientAttempts, 4);
  assert.deepEqual(delays, [250, 750, 1500]);
});

test("prepare script uses the retry helper while retaining pinned SHA-256 verification", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "prepare-tunnel-client.cjs"), "utf8");
  assert.match(source, /require\("\.\/tunnel-client-download\.cjs"\)/);
  assert.match(source, /fetchBytesWithRetry\(releaseUrl\(file\)\)/);
  assert.doesNotMatch(source, /await fetch\(releaseUrl\(file\)/);
  assert.match(source, /const actual = sha256\(archive\);[\s\S]{0,180}actual !== expectedSha256[\s\S]{0,220}SHA-256 mismatch/);
});
