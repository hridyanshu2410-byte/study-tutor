// Files the browser loads directly, copied from node_modules into public/ on
// install: SQLite's wasm for the Anki importer (sql.js, MIT) and the PDF
// renderer's worker for worksheet uploads (pdfjs-dist, Apache-2.0).
import fs from "node:fs";

fs.mkdirSync("public", { recursive: true });
fs.copyFileSync("node_modules/sql.js/dist/sql-wasm-browser.wasm", "public/sql-wasm-browser.wasm");
fs.copyFileSync("node_modules/pdfjs-dist/build/pdf.worker.min.mjs", "public/pdf.worker.min.mjs");
