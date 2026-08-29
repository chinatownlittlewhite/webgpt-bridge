const crypto = require("node:crypto");
const { BROKER_PROTOCOL_VERSION } = require("./product-contract.cjs");

const MAX_FIELD_LENGTH = 512;

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_FIELD_LENGTH || value.includes("\n") || value.includes("\u0000")) {
    throw new TypeError(`${name} must be a bounded non-empty string`);
  }
  return value;
}

function createBrokerBootstrap({
  randomSessionId = crypto.randomUUID,
  randomSecret = () => crypto.randomBytes(32).toString("base64url"),
} = {}) {
  if (typeof randomSessionId !== "function" || typeof randomSecret !== "function") throw new TypeError("broker randomness providers must be functions");
  return Object.freeze({
    protocolVersion: BROKER_PROTOCOL_VERSION,
    sessionId: nonEmptyString(randomSessionId(), "sessionId"),
    secret: nonEmptyString(randomSecret(), "secret"),
  });
}

function proofPayload({ protocolVersion, sessionId, agentVersion, nonce }) {
  if (!Number.isInteger(protocolVersion)) throw new TypeError("protocolVersion must be an integer");
  return `${protocolVersion}\n${nonEmptyString(sessionId, "sessionId")}\n${nonEmptyString(agentVersion, "agentVersion")}\n${nonEmptyString(nonce, "nonce")}`;
}

function createBrokerProof({ protocolVersion, sessionId, agentVersion, nonce, secret } = {}) {
  const key = nonEmptyString(secret, "secret");
  return crypto.createHmac("sha256", key).update(proofPayload({ protocolVersion, sessionId, agentVersion, nonce })).digest("base64url");
}

function protocolError(code) {
  return Object.freeze({ type: "hello_error", code });
}

function createBrokerChallenge(hello, bootstrap, { randomNonce = () => crypto.randomBytes(24).toString("base64url") } = {}) {
  if (!bootstrap || bootstrap.protocolVersion !== BROKER_PROTOCOL_VERSION) return protocolError("BROKER_PROTOCOL_MISMATCH");
  if (!hello || hello.type !== "hello" || hello.protocolVersion !== bootstrap.protocolVersion) return protocolError("BROKER_PROTOCOL_MISMATCH");
  if (hello.sessionId !== bootstrap.sessionId) return protocolError("BROKER_AUTH_FAILED");
  try {
    nonEmptyString(hello.agentVersion, "agentVersion");
    if (typeof randomNonce !== "function") throw new TypeError("randomNonce must be a function");
    const nonce = nonEmptyString(randomNonce(), "nonce");
    return Object.freeze({ type: "challenge", nonce });
  } catch {
    return protocolError("BROKER_AUTH_FAILED");
  }
}

function decodeProof(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const buffer = Buffer.from(value, "base64url");
    return buffer.length === 32 ? buffer : null;
  } catch {
    return null;
  }
}

function verifyBrokerProof(candidate, bootstrap, { expectedNonce } = {}) {
  try {
    if (!bootstrap || bootstrap.protocolVersion !== BROKER_PROTOCOL_VERSION) return Object.freeze({ ok: false, code: "BROKER_PROTOCOL_MISMATCH" });
    if (!candidate || candidate.protocolVersion !== bootstrap.protocolVersion || candidate.sessionId !== bootstrap.sessionId) {
      return Object.freeze({ ok: false, code: "BROKER_AUTH_FAILED" });
    }
    if (expectedNonce !== undefined && candidate.nonce !== expectedNonce) return Object.freeze({ ok: false, code: "BROKER_AUTH_FAILED" });
    const expected = decodeProof(createBrokerProof({
      protocolVersion: candidate.protocolVersion,
      sessionId: candidate.sessionId,
      agentVersion: candidate.agentVersion,
      nonce: candidate.nonce,
      secret: bootstrap.secret,
    }));
    const actual = decodeProof(candidate.proof);
    if (!expected || !actual || expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      return Object.freeze({ ok: false, code: "BROKER_AUTH_FAILED" });
    }
    return Object.freeze({ ok: true });
  } catch {
    return Object.freeze({ ok: false, code: "BROKER_AUTH_FAILED" });
  }
}

module.exports = {
  BROKER_PROTOCOL_VERSION,
  createBrokerBootstrap,
  createBrokerChallenge,
  createBrokerProof,
  verifyBrokerProof,
};
