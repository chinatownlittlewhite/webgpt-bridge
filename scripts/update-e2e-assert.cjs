const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

function safeRequestName(rawUrl) {
  const raw = String(rawUrl || "");
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("?") || raw.includes("#")) {
    throw new Error("unsafe update E2E request path");
  }
  let name;
  try {
    name = decodeURIComponent(raw.slice(1));
  } catch {
    throw new Error("unsafe update E2E request path");
  }
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || path.basename(name) !== name) {
    throw new Error("unsafe update E2E request path");
  }
  return name;
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(String(header).trim());
  if (!match) throw new Error("invalid range");
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) throw new Error("invalid range");
  return { start, end: Math.min(end, size - 1) };
}

function readSentinel(file, expectedVersion) {
  if (!fs.existsSync(file)) return null;
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("malformed update E2E sentinel");
  }
  if (!value || typeof value !== "object" || typeof value.version !== "string" || typeof value.phase !== "string" || !Number.isInteger(value.pid) || typeof value.platform !== "string") {
    throw new Error("malformed update E2E sentinel");
  }
  if (value.phase === "failed") throw new Error(`packaged updater E2E failed at version ${value.version}`);
  if (value.phase === "updated") {
    if (value.version !== expectedVersion) throw new Error(`updated sentinel version mismatch: ${value.version}`);
    return value;
  }
  if (value.phase !== "installing") throw new Error(`unexpected update E2E sentinel phase: ${value.phase}`);
  return null;
}

function createFileServer(root) {
  const assetRoot = path.resolve(root);
  return http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end();
      return;
    }

    let name;
    try {
      name = safeRequestName(req.url);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const file = path.join(assetRoot, name);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }

    let range;
    try {
      range = parseRange(req.headers.range, stat.size);
    } catch {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Accept-Ranges": "bytes" });
      res.end();
      return;
    }

    const headers = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Type": "application/octet-stream",
    };
    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    if (range) {
      ({ start, end } = range);
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers["Content-Length"] = String(Math.max(0, end - start + 1));
    res.writeHead(status, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
  });
}

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

async function runAssertionServer({ root, port, sentinel, expectedVersion, timeoutMs, ready }) {
  const assetRoot = path.resolve(root);
  const sentinelPath = path.resolve(sentinel);
  if (!fs.statSync(assetRoot, { throwIfNoEntry: false })?.isDirectory()) throw new Error("update E2E asset root does not exist");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("invalid update E2E port");
  if (!expectedVersion) throw new Error("expected update E2E version is required");
  const server = createFileServer(assetRoot);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  if (ready) {
    const readyPath = path.resolve(ready);
    fs.mkdirSync(path.dirname(readyPath), { recursive: true });
    fs.writeFileSync(readyPath, JSON.stringify({ host: "127.0.0.1", port }), { mode: 0o600 });
  }

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = readSentinel(sentinelPath, expectedVersion);
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("packaged updater E2E timed out");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

if (require.main === module) {
  runAssertionServer({
    root: argument("--root"),
    port: Number(argument("--port", "18181")),
    sentinel: argument("--sentinel"),
    expectedVersion: argument("--expected-version"),
    timeoutMs: Number(argument("--timeout-ms", "240000")),
    ready: argument("--ready"),
  }).then((result) => {
    console.log(JSON.stringify({ ok: true, ...result }));
  }).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { safeRequestName, parseRange, readSentinel, createFileServer, runAssertionServer };
