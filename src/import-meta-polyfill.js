// Polyfill for import.meta.url in CJS context
const url = require("url");
const path = require("path");

export const importMetaUrl = url.pathToFileURL(__filename).href;
