"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRuntimeConfig = createRuntimeConfig;
const config_1 = require("../../core/config");
function createRuntimeConfig(overrides = {}) {
    return (0, config_1.searchConfigFromEnv)(overrides);
}
