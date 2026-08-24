function createApprovalSession() {
  const remembered = new Set();
  return Object.freeze({
    isRemembered(prompt) {
      return Boolean(prompt?.rememberKey && remembered.has(prompt.rememberKey));
    },
    record(prompt, { approved = false, remember = false } = {}) {
      if (approved && remember && prompt?.rememberKey) remembered.add(prompt.rememberKey);
    },
    clear() {
      remembered.clear();
    },
  });
}

module.exports = { createApprovalSession };
