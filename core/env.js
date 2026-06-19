"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadEnvFile = loadEnvFile;
function unquoteEnvValue(value) {
    const trimmed = value.trim();
    if (trimmed.length < 2)
        return trimmed;
    const quote = trimmed[0];
    if ((quote !== `"` && quote !== "'") || trimmed[trimmed.length - 1] !== quote) {
        return trimmed;
    }
    const inner = trimmed.slice(1, -1);
    if (quote === "'")
        return inner;
    return inner
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, `"`)
        .replace(/\\\\/g, "\\");
}
function parseEnvLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#"))
        return null;
    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
    const separatorIndex = withoutExport.indexOf("=");
    if (separatorIndex <= 0)
        return null;
    const key = withoutExport.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        return null;
    return [key, unquoteEnvValue(withoutExport.slice(separatorIndex + 1))];
}
function loadEnvFile(filePath = ".env", override = false) {
    const fs = require("node:fs");
    const path = require("node:path");
    const resolvedPath = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(resolvedPath))
        return false;
    const content = fs.readFileSync(resolvedPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
        const parsed = parseEnvLine(line);
        if (!parsed)
            continue;
        const [key, value] = parsed;
        if (override || process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
    return true;
}
