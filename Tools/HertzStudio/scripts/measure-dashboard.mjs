import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "../web/dist");
const reportPath = path.resolve(__dirname, "../data/dashboard-size-report.json");
const indexHtml = path.join(distDir, "index.html");

if (!fs.existsSync(distDir)) {
  console.error("web/dist missing. Run: npm run build -w web");
  process.exit(1);
}

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

/** Chunks that must stay off the initial Dashboard/Find route graph. */
function isDeferred3d(rel) {
  return /three|viewport-3d|react-three|ModelViewer|OrbitControls|GLTFLoader|SketchfabEmbed/i.test(rel);
}

const html = fs.existsSync(indexHtml) ? fs.readFileSync(indexHtml, "utf8") : "";
const entryScripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1].replace(/^\//, ""));
const entryLoads3d = entryScripts.some((s) => isDeferred3d(s));

const files = walk(distDir).filter((f) => f.endsWith(".js") || f.endsWith(".css"));
const assets = files.map((file) => {
  const buf = fs.readFileSync(file);
  const gzip = gzipSync(buf);
  const rel = path.relative(distDir, file).replaceAll("\\", "/");
  return {
    file: rel,
    bytes: buf.length,
    gzipBytes: gzip.length,
    is3d: isDeferred3d(rel),
    inHtmlEntry: entryScripts.some((s) => rel.endsWith(s.replace(/^assets\//, "")) || s.includes(path.basename(rel))),
  };
});

const firstPartyJs = assets.filter((a) => a.file.endsWith(".js") && !a.is3d);
const totalGzipJs = firstPartyJs.reduce((sum, a) => sum + a.gzipBytes, 0);
const has3dChunk = assets.some((a) => a.is3d);
const threeExcludedFromBudget = has3dChunk && !entryLoads3d;

const report = {
  measuredAt: new Date().toISOString(),
  targetGzipJsBytes: 250 * 1024,
  dashboardFirstPartyGzipJsBytes: totalGzipJs,
  underTarget: totalGzipJs <= 250 * 1024,
  threeBundleExcludedFromDashboard: threeExcludedFromBudget,
  htmlEntryLoads3d: entryLoads3d,
  entryScripts,
  note: "Dashboard/Find must not import Three/GLTFLoader/ModelViewer in the HTML entry graph. Those chunks are lazy on details routes only. LCP/INP/CLS remain pending browser profiling.",
  assets,
};

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.underTarget && threeExcludedFromBudget && !entryLoads3d ? 0 : 1);
