// The Anki deck importer runs SQLite in the browser (sql.js, MIT). Its wasm
// binary is served from public/, copied from node_modules on install.
import fs from "node:fs";

fs.mkdirSync("public", { recursive: true });
fs.copyFileSync("node_modules/sql.js/dist/sql-wasm-browser.wasm", "public/sql-wasm-browser.wasm");
