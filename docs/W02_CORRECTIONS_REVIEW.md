# W02 corrections follow-up review

20 October 2026. **Verdict: changes required; do not start W03.** Unified provider search, details routes, lazy model viewing, upload controls, connector root discovery, Sketchfab archive extraction, and recovery scaffolding improved. The following acceptance and safety gaps remain.

## Findings

1. **[P1] Durable-store backup promotion still fails continuously on Windows.** `api/src/store.mjs:116-129` renames a temp file over an existing `.good` file and `saveStore` only logs the failure. The live API log contains repeated `EPERM` errors and the data directory has 101 `store.json.good.*.tmp` files from current API PID 14356. Implement Windows-safe replacement, clean the temp in `finally`, expose degraded backup state, and add a real filesystem regression.

2. **[P1] glTF dependencies still fail in the library viewer and are not proven through Unity.** Kingsley reproduced `THREE.GLTFLoader: Failed to load buffer "scene.bin".` on library asset `59813a75-319f-4ff1-9d8a-59fc9e8e4356`; the details page lists `scene.bin` and texture dependencies but the live browser cannot fetch them. Current URL rewriting and `/model-dep/:name` source checks are insufficient evidence. Preserve each dependency relative path without basename flattening, serve nested buffers/images with owner authentication and correct MIME/cache headers, verify the dependency blob exists before marking Preview ready, and make viewer errors identify the failed request/status. The connector and Unity bridge must copy the same complete relative tree. Add a real browser test and API -> connector -> bridge proof using nested duplicate basenames, a buffer, and textures.

3. **[P1] The Unity source boundary is too broad and misses ancestor junctions.** `HertzStudioHttpBridge.cs:862-875` accepts any file under `Application.dataPath`. `IsReparsePoint` checks only the final file. Require relative sources under `Assets/HertzStudio/Imported/_incoming/<UUID>/`, reject request absolute paths, walk ancestors for reparse points, and validate before any write.

4. **[P1] Content validation rejects a real Sketchfab glTF and still accepts malformed supported files.** Kingsley reproduced `Content is not a glTF JSON document.` by clicking Import to Library for Sketchfab model `8e1ba8a437c4460eaaa643953eaf79d0`. `content-validate.mjs:27-74` inspects only the first 64 bytes, so valid JSON with a BOM, whitespace, formatting, or an `asset` object later in the document is rejected; it also accepts short magic prefixes and leaves `.ttf`, `.otf`, and `.anim` structurally unchecked. Parse the complete bounded glTF JSON, validate `asset.version` and safe dependency URIs, validate declared GLB/image/audio/font/animation/ZIP structure, and add a faithful archive fixture that reproduces this UID failure plus valid-looking truncated negative fixtures. A failed import must leave no catalog row, blob, extraction directory, or partial upload.

5. **[P1] Browser cancel/resume is not reliable or restart-safe.** `chunkedUpload.js:28-70` does not delete the session when an in-flight fetch is aborted; that becomes an interruption. `AssetLibrary.jsx:123-247` stores file/ID/offset only in a React ref, so reload/navigation loses resume state, and retry errors lose the newest offset. Persist non-secret metadata, add reselect-and-verify and server-offset reconciliation, and test mid-fetch cancel, failed-chunk retry, and reload resume.

6. **[P1] The retired default password remains in executable scripts/docs.** `scripts/local-pair.mjs:10`, `scripts/proof-drafts.mjs:83`, and `README.md:29` retain `hertz-local-owner`; `server.mjs:397` still says local default. Remove every fallback/reference, make automation require explicit configuration, scan the full Studio source tree, and reset or migrate local credentials created from the retired default.

7. **[P1] Live verification is not currently clean.** The saved GLB proof used connector PID 25472, which has exited. No connector is running, bridge 8791 is unreachable, and Editor.log contains earlier `CS0104` bridge errors. Restore the bridge, compile current C# with zero errors, run exactly one connector, and rerun current GLB plus dependency-preserving glTF proofs with current PIDs/log times.

8. **[P2] The stop script can kill an unrelated reused PID.** `scripts/stop-connector.mjs:12-25` trusts the PID file and sends SIGTERM without identity verification. Store and verify an instance nonce/start time/command identity or use owned IPC.

9. **[P1] Sketchfab models must be interactively previewable before library import.** The screenshot confirms `AssetDetail.jsx:71-81` loads ModelViewer only for library assets and tells the user to import first. On `/find-assets/sketchfab/:uid`, render an official lazy Sketchfab viewer/embed when the model permits it so the user can orbit, zoom, pan, reset, and inspect the model before importing. Fetch and show provider name, author, license, size/geometry/rig/animation fields when the documented provider API supplies them; label unavailable values Unknown. Show an actionable thumbnail/fallback when embedding is unavailable. Test the full result -> details -> preview -> Import to Library flow with UID `8e1ba8a437c4460eaaa643953eaf79d0`.

10. **[P2] Animation type selection is missing.** FBX is always classified as `model_3d` and upload has no model/animation selector. Carry a validated compatible override through chunk init/complete and test animation FBX plus invalid overrides.

11. **[P2] The performance report contradicts the handoff.** `measure:dashboard` reports `threeBundleExcludedFromDashboard: false` while the handoff claims exclusion. Verify the initial route graph or browser network trace and keep Three/GLTFLoader off Dashboard/Find until a viewer opens.

12. **[P2] Full provider images are cropped, and imported model cards discard useful preview imagery.** `FindAssets.jsx:290-295` and `AssetDetail.jsx:243-247` use `object-cover`, while imported models appear only as generic `3D (on demand)` cards. Preserve a bounded, validated local copy of the provider thumbnail or generate a local model still during import; do not hotlink credentials. Library cards and details must show the complete image at original aspect ratio with `object-contain`, falling back to the generic model state only when no preview exists. Clicking the image opens a responsive lightbox with zoom, pan, fit/reset, fullscreen, close/Escape/backdrop controls, keyboard focus handling, and Open original for a verified URL. Test imported Sketchfab cards plus portrait, landscape, transparent, very large, and failed images.

13. **[P1] Assets cannot be deleted from the library.** Add an owner-only Delete asset action on each library card and details page. Require an explicit confirmation containing the asset name and consequences. The server must validate the UUID, serialize the mutation, remove/cancel queued import jobs, remove the catalog row, source blob, dependency blobs, preview files, abandoned upload state, and asset-scoped temporary files without touching unrelated/shared files. Make deletion idempotent and crash-safe; a partial failure must surface recovery state rather than leave an apparently deleted asset or orphaned storage. If the asset was imported into Unity, default to preserving the Unity copy and clearly say so; never delete Unity files, prefabs, scenes, or GUIDs as a side effect of Delete from library. Add tests for ordinary, dependency-rich, queued, Unity-imported, repeated, traversal, and interrupted deletion, plus immediate UI removal and storage quota refresh.

## Verification performed

- `npm run test:web`: **25/25 passed**.
- `npm run regress:w02`: **73/73 passed**; live Sketchfab remains pending.
- `npm run regress:w01`: **27/27 passed**.
- `npm run build`: **passed**.
- `npm run measure:dashboard`: **158,734 gzip JS bytes**, but `threeBundleExcludedFromDashboard` is false.
- API 8787: healthy, PID 14356. Unity bridge 8791: unreachable. Connector: not running.

Passing source-pattern/unit checks do not cover these live failures. W02 remains open.
