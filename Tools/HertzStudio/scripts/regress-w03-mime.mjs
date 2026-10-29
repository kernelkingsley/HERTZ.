/**
 * Priority 1 #7: forged / mismatched file signatures vs extension.
 * Isolated HERTZ_STUDIO_DATA — never touches the live store.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w03-mime-"));
process.env.HERTZ_STUDIO_DATA = dataDir;

const contentValidate = await import("../api/src/assets/content-validate.mjs");
const catalog = await import("../api/src/assets/catalog.mjs");

const checks = [];
function check(name, pass, detail = undefined) {
  checks.push({ name, pass: Boolean(pass), detail });
  assert.ok(pass, detail ? `${name}: ${detail}` : name);
}

function pngBytes() {
  // Minimal valid-looking PNG signature + IHDR length padding (≥67 bytes required).
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, Buffer.alloc(70, 0)]);
}

function jpegBytes() {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  return Buffer.concat([head, Buffer.alloc(120, 0)]);
}

// Extension says PNG, content is JPEG.
{
  const p = path.join(dataDir, "jpeg-as.png");
  fs.writeFileSync(p, jpegBytes());
  const r = contentValidate.validateFileContent(p, "jpeg-as.png");
  check("rejects_jpeg_bytes_named_png", r.ok === false && /PNG|signature/i.test(r.error || ""), r.error);
}

// Extension says JPEG, content is PNG.
{
  const p = path.join(dataDir, "png-as.jpg");
  fs.writeFileSync(p, pngBytes());
  const r = contentValidate.validateFileContent(p, "png-as.jpg");
  check("rejects_png_bytes_named_jpeg", r.ok === false && /JPEG|signature/i.test(r.error || ""), r.error);
}

// Extension says GLB, content is plain text.
{
  const p = path.join(dataDir, "text.glb");
  fs.writeFileSync(p, "not-a-glb-file");
  const r = contentValidate.validateFileContent(p, "text.glb");
  check("rejects_text_named_glb", r.ok === false, r.error);
}

// Extension says WAV, content is Ogg-like header.
{
  const p = path.join(dataDir, "ogg-as.wav");
  fs.writeFileSync(p, Buffer.concat([Buffer.from("OggS"), Buffer.alloc(40, 0)]));
  const r = contentValidate.validateFileContent(p, "ogg-as.wav");
  check("rejects_ogg_bytes_named_wav", r.ok === false && /WAV|signature/i.test(r.error || ""), r.error);
}

// Real PNG accepted; forged PNG rejected by ingest.
{
  const good = path.join(dataDir, "ok.png");
  fs.writeFileSync(good, pngBytes());
  check("accepts_png_signature", contentValidate.validateFileContent(good, "ok.png").ok === true);

  const forged = path.join(dataDir, "forged.png");
  fs.writeFileSync(forged, "MIME: image/png\nbut not really");
  let ingestRejected = false;
  try {
    catalog.ingestFile({ absolutePath: forged, originalName: "forged.png", provider: "upload" });
  } catch (err) {
    ingestRejected =
      err.code === "invalid_content" || /PNG|signature|Content|Invalid/i.test(err.message || "");
  }
  check("ingest_rejects_forged_png_mime_claim", ingestRejected);
}

assert.equal(checks.filter((c) => !c.pass).length, 0);
console.log(JSON.stringify({ ok: true, checks: checks.length, dataDir, results: checks }, null, 2));
