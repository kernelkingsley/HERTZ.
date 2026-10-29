import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const t = await (
  await fetch("https://kenney.nl/assets", {
    headers: { "User-Agent": "HERTZ-Studio/0.1 (+local; Kenney catalog index)" },
  })
).text();
console.log("len", t.length);
const scripts = [...t.matchAll(/src=['"]([^'"]+)['"]/g)].map((m) => m[1]);
console.log("scripts\n" + scripts.join("\n"));
mkdirSync(join(root, "../data/tmp"), { recursive: true });
writeFileSync(join(root, "../data/tmp/kenney-assets.html"), t);
console.log("wrote tmp html");
const idx = t.indexOf("Tiny");
console.log("Tiny idx", idx, t.slice(Math.max(0, idx - 80), idx + 200));
