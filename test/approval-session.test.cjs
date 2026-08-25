const test = require("node:test");
const assert = require("node:assert/strict");

function api() {
  return require("../src/approval-session.cjs");
}

test("automatically remembers approved permission classes for the current connection", () => {
  const { createApprovalSession } = api();
  const session = createApprovalSession();
  const gitPrompt = { rememberKey: "terminal:git-local" };
  const networkPrompt = { rememberKey: null };

  assert.equal(session.isRemembered(gitPrompt), false);
  session.record(gitPrompt, { approved: true });
  assert.equal(session.isRemembered(gitPrompt), true);

  session.record(networkPrompt, { approved: true });
  assert.equal(session.isRemembered(networkPrompt), false);

  session.clear();
  assert.equal(session.isRemembered(gitPrompt), false);
});

test("does not remember declined or unclassified approvals", () => {
  const { createApprovalSession } = api();
  const session = createApprovalSession();
  const prompt = { rememberKey: "files:destructive" };
  session.record(prompt, { approved: false });
  assert.equal(session.isRemembered(prompt), false);
  session.record({ rememberKey: null }, { approved: true });
  assert.equal(session.isRemembered({ rememberKey: null }), false);
});
