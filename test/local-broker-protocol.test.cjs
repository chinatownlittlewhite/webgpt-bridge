const test = require("node:test");
const assert = require("node:assert/strict");

function api() {
  return require("../shared/local-broker-protocol.cjs");
}

function containsSecret(value, secret) {
  return JSON.stringify(value).includes(secret);
}

test("broker challenge verifies exact protocol session and HMAC proof without transmitting the secret", () => {
  const {
    BROKER_PROTOCOL_VERSION,
    createBrokerBootstrap,
    createBrokerChallenge,
    createBrokerProof,
    verifyBrokerProof,
  } = api();
  const bootstrap = createBrokerBootstrap({
    randomSessionId: () => "session-1",
    randomSecret: () => "secret-1",
  });
  const hello = { type: "hello", protocolVersion: BROKER_PROTOCOL_VERSION, sessionId: "session-1", agentVersion: "0.9.3" };
  const challenge = createBrokerChallenge(hello, bootstrap, { randomNonce: () => "nonce-1" });

  assert.equal(challenge.type, "challenge");
  assert.equal(challenge.nonce, "nonce-1");
  assert.equal(containsSecret(challenge, bootstrap.secret), false);

  const proof = createBrokerProof({ ...hello, nonce: challenge.nonce, secret: bootstrap.secret });
  const accepted = verifyBrokerProof({ ...hello, nonce: challenge.nonce, proof }, bootstrap, { expectedNonce: challenge.nonce });
  assert.deepEqual(accepted, { ok: true });
  assert.equal(containsSecret(accepted, bootstrap.secret), false);

  const versionError = createBrokerChallenge({ ...hello, protocolVersion: BROKER_PROTOCOL_VERSION + 1 }, bootstrap);
  assert.equal(versionError.code, "BROKER_PROTOCOL_MISMATCH");
  assert.equal(containsSecret(versionError, bootstrap.secret), false);

  const authError = verifyBrokerProof({ ...hello, nonce: challenge.nonce, proof: "wrong" }, bootstrap, { expectedNonce: challenge.nonce });
  assert.equal(authError.code, "BROKER_AUTH_FAILED");
  assert.equal(containsSecret(authError, bootstrap.secret), false);
});

test("broker proof is bound to the exact session and per-connection nonce", () => {
  const {
    BROKER_PROTOCOL_VERSION,
    createBrokerBootstrap,
    createBrokerChallenge,
    createBrokerProof,
    verifyBrokerProof,
  } = api();
  const bootstrap = createBrokerBootstrap({
    randomSessionId: () => "session-1",
    randomSecret: () => "secret-1",
  });
  const hello = { type: "hello", protocolVersion: BROKER_PROTOCOL_VERSION, sessionId: "session-1", agentVersion: "0.9.3" };
  const first = createBrokerChallenge(hello, bootstrap, { randomNonce: () => "nonce-1" });
  const second = createBrokerChallenge(hello, bootstrap, { randomNonce: () => "nonce-2" });
  const firstProof = createBrokerProof({ ...hello, nonce: first.nonce, secret: bootstrap.secret });

  assert.deepEqual(
    verifyBrokerProof({ ...hello, nonce: first.nonce, proof: firstProof }, bootstrap, { expectedNonce: first.nonce }),
    { ok: true },
  );
  assert.equal(
    verifyBrokerProof({ ...hello, nonce: first.nonce, proof: firstProof }, bootstrap, { expectedNonce: second.nonce }).code,
    "BROKER_AUTH_FAILED",
  );
  assert.equal(
    verifyBrokerProof({ ...hello, sessionId: "session-2", nonce: first.nonce, proof: firstProof }, bootstrap, { expectedNonce: first.nonce }).code,
    "BROKER_AUTH_FAILED",
  );
});
