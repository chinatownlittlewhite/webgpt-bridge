const { createBuilderConfig } = require("./build/electron-builder-options.cjs");

module.exports = createBuilderConfig(process.env);
