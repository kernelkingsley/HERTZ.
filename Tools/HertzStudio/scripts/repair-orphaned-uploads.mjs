/**
 * One-shot repair for completed chunked uploads whose asset rows were wiped by the
 * stale completeChunkedUpload catalog overwrite. Safe to re-run.
 *
 * Usage (cwd Tools/HertzStudio): node scripts/repair-orphaned-uploads.mjs
 */
import { repairOrphanedCompletedUploads, listAssets } from "../api/src/assets/catalog.mjs";

const report = repairOrphanedCompletedUploads();
const sample = listAssets({ page: 1, pageSize: 5, q: "HERTZ_Pistol" });
console.log(
  JSON.stringify(
    {
      ok: true,
      report,
      pistolMatches: sample.assets.map((a) => ({ id: a.id, displayName: a.displayName, state: a.state })),
    },
    null,
    2,
  ),
);
