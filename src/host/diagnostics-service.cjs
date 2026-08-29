const { createProductMetadata } = require("../../shared/product-metadata.cjs");

function createDiagnosticsService({ brokerEnabled = true } = {}) {
  const enabled = brokerEnabled === true;
  return Object.freeze({
    snapshot: () => createProductMetadata({ brokerEnabled: enabled }),
  });
}

module.exports = { createDiagnosticsService };
