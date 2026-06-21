const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const src = path.join(root, "src");
const dist = path.join(root, "dist");

fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(src, dist, { recursive: true });
