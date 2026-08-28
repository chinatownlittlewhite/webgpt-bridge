const http = require("node:http");
const net = require("node:net");

const HEALTH_TARGETS = Object.freeze({
  agent: Object.freeze({ kind: "http", host: "127.0.0.1", port: 8787, path: "/healthz" }),
  tunnel: Object.freeze({ kind: "http", host: "127.0.0.1", port: 8080, path: "/readyz" }),
  github: Object.freeze({ kind: "tcp", host: "github.com", port: 443 }),
});

function defaultHttpProbe(target, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    const req = http.get({ host: target.host, port: target.port, path: target.path, timeout: timeoutMs }, (res) => {
      res.resume();
      res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, statusCode: res.statusCode }));
    });
    req.once("error", (error) => resolve({ ok: false, error: error.message }));
    req.once("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
  });
}

function defaultTcpProbe(target, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: target.host, port: target.port });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: "timeout" }));
    socket.once("connect", () => finish({ ok: true }));
    socket.once("error", (error) => finish({ ok: false, error: error.message }));
  });
}

function createLoopbackHealthProbe({ targets = {}, httpProbe = defaultHttpProbe, tcpProbe = defaultTcpProbe, githubProbe } = {}) {
  const definitions = Object.freeze({ ...HEALTH_TARGETS, ...targets, github: HEALTH_TARGETS.github });
  async function probe({ target } = {}) {
    if (!Object.hasOwn(definitions, target)) throw new TypeError("health target 只能是 agent、tunnel 或 github。");
    if (target === "github" && typeof githubProbe === "function") {
      return Object.freeze({ target, ...await githubProbe() });
    }
    const definition = definitions[target];
    const request = definition.kind === "http"
      ? { host: definition.host, port: definition.port, path: definition.path }
      : { host: definition.host, port: definition.port };
    const result = definition.kind === "http" ? await httpProbe(request) : await tcpProbe(request);
    return Object.freeze({ target, ...result });
  }
  return Object.freeze({ probe });
}

module.exports = { HEALTH_TARGETS, createLoopbackHealthProbe, defaultHttpProbe, defaultTcpProbe };
