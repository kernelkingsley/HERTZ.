import fs from "node:fs";
import path from "node:path";
import yauzl from "yauzl";
import { LIMITS } from "./types.mjs";

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
      if (err) reject(err);
      else resolve(zip);
    });
  });
}

function isUnsafeEntryName(name) {
  const normalized = name.replace(/\\/g, "/");
  if (!normalized || normalized.endsWith("/")) return false;
  if (path.isAbsolute(normalized)) return true;
  if (normalized.includes("\0")) return true;
  if (normalized.split("/").some((p) => p === "..")) return true;
  if (/^[a-zA-Z]:/.test(normalized)) return true;
  return false;
}

/**
 * Safely extract a ZIP into destDir. Rejects traversal, absolute paths, links, bombs.
 * @returns {{ files: Array<{ relativePath: string, absolutePath: string, size: number }>, rejected: string[] }}
 */
export async function safeExtractZip(zipPath, destDir, limits = LIMITS) {
  fs.mkdirSync(destDir, { recursive: true });
  const zip = await openZip(zipPath);
  const files = [];
  const rejected = [];
  let extractedBytes = 0;
  let entryCount = 0;

  await new Promise((resolve, reject) => {
    zip.readEntry();
    zip.on("entry", (entry) => {
      const name = entry.fileName;
      if (/\/$/.test(name)) {
        zip.readEntry();
        return;
      }
      entryCount += 1;
      if (entryCount > limits.maxZipEntries) {
        reject(new Error(`ZIP exceeds max file count (${limits.maxZipEntries}).`));
        return;
      }
      // yauzl may emit errors for some unsafe names before we see the entry;
      // still guard explicitly for traversal / absolute / null bytes.
      if (isUnsafeEntryName(name)) {
        rejected.push(`unsafe path: ${name}`);
        zip.readEntry();
        return;
      }
      // yauzl sets isDirectory; externalFileAttributes may indicate symlink on unix zips
      const isLink = (entry.externalFileAttributes >>> 16 & 0o170000) === 0o120000;
      if (isLink) {
        rejected.push(`symlink rejected: ${name}`);
        zip.readEntry();
        return;
      }
      const uncompressed = entry.uncompressedSize || 0;
      if (uncompressed > limits.maxFileBytes) {
        rejected.push(`file too large: ${name}`);
        zip.readEntry();
        return;
      }
      extractedBytes += uncompressed;
      if (extractedBytes > limits.maxExtractedBytes) {
        reject(new Error(`ZIP extracted size exceeds limit (${limits.maxExtractedBytes} bytes).`));
        return;
      }

      const dest = path.resolve(destDir, name);
      if (!dest.startsWith(path.resolve(destDir) + path.sep) && dest !== path.resolve(destDir)) {
        rejected.push(`path escape: ${name}`);
        zip.readEntry();
        return;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      zip.openReadStream(entry, (err, readStream) => {
        if (err) {
          reject(err);
          return;
        }
        const write = fs.createWriteStream(dest);
        let written = 0;
        readStream.on("data", (chunk) => {
          written += chunk.length;
          if (written > limits.maxFileBytes) {
            readStream.destroy(new Error(`Decompression bomb or oversized member: ${name}`));
          }
        });
        readStream.pipe(write);
        write.on("close", () => {
          files.push({ relativePath: name.replace(/\\/g, "/"), absolutePath: dest, size: written });
          zip.readEntry();
        });
        write.on("error", reject);
        readStream.on("error", reject);
      });
    });
    zip.on("end", resolve);
    zip.on("error", (err) => {
      const msg = String(err?.message || err);
      if (/invalid relative path|absolute path|invalid.*path/i.test(msg)) {
        rejected.push(`unsafe path rejected by parser: ${msg}`);
        resolve();
        return;
      }
      reject(err);
    });
  });

  return { files, rejected, entryCount, extractedBytes };
}
