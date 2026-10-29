#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, [path.join(root, "connector/src/connector.mjs")], {
  cwd: path.join(root, "connector"),
  stdio: "inherit",
  env: { ...process.env, HERTZ_CONNECTOR_FORCE_START: "1" },
});
child.on("exit", (code) => process.exit(code ?? 1));
