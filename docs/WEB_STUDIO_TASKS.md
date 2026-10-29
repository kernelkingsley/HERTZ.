# HERTZ Studio: Cursor/Grok implementation tasks

Updated 20 October 2026. **HERTZ Studio** is the hosted web interface for authoring the Unity game. It must be usable from another computer without running a local web server. Keep its source in this repository and deploy its web/API components separately from Unity. Implement only the task selected in `WORK_PLAN.md`, then hand it back for review. W01-W14 are approved scope, queued one task at a time. Kingsley approved the game editors/integrations, optimized hosting, and a local Studio deployment page for **hertz.software**, registered through **Name.com**. Hosting-provider selection and optional Student Pack integrations remain open; Blender/new custom MCP remain unapproved.

## Shared instructions for every task

Read `WORK_PLAN.md`, every `.cursor/rules/*.mdc`, and [the reference guide](references/web-studio/README.md). **Do not use the supplied screenshots as UI references.** Build an original, polished HERTZ Studio interface with the installed Shadcn plugin (Tailwind + shadcn components). Screenshots may remain in the repo as historical context only; they do not dictate layout, styling, or visual language.

Inspect existing code first. At scoping time the project uses Unity **6000.0.85f1**, URP **17.0.4**, XRI **3.4.1**, and OpenXR **1.16.1**. No custom gameplay C# scripts outside template/sample folders or existing web app were found. Do not assume weapon, character, AI, analytics, navigation, or glTF import systems already exist. Recheck before implementation; use installed package source or matching official docs for APIs.

Preserve HERTZ: first-person Quest 3S game, town and spirits, frequency flip, dual pistols available only after flipping. The editor may manage models, surfaces, audio, UI, animation, tuning, and encounter timing; it does not authorize new weapon classes, monetization, chapters, or unrelated gameplay. Enemy/encounter authoring must use existing or explicitly selected content; do not populate the working scene with invented encounters.

Keep web/API/connector source outside Unity's `Assets` (suggested `Tools/HertzStudio/`), Editor integration isolated from player builds, and shared runtime data independent of Editor APIs. One repository, independently deployable web/API components; never upload Unity source, Library, or node_modules as public site content. Reuse dependencies/documented APIs. Sketchfab remains included. Kenney covers **2D, 3D, UI, Audio, Pixel, Textures** through free individual packs. Mixamo uses browser download/file import unless a supported integration is verified. Poly Haven uses its documented API with provider credit/User-Agent. Target free allowances or explicitly selected/verified student benefits; track expiry and quotas, with no paid overages/add-ons or unlimited-free claims. Kingsley owns **hertz.software at Name.com**. Confirmed production URL is `https://studio.hertz.software`, selected by Kingsley; use it as the Deploy default and preserve the root domain. A domain/DNS token and host token are separate. See [Student Pack options](STUDENT_PACK_OPTIONS.md); no cloud host is selected or credit balance verified yet.

### Hosted architecture and disconnected Unity

**Hosting setup deferred by Kingsley on 20 October 2026.** Develop and verify the cloud-ready components locally for now. Do not retry student verification, provision hosting, deploy publicly, or change DNS until hosting is revisited. Keep live-host checks pending; local checks do not establish remote operation. W14 remains queued for later hosting setup.

- **Browser + hosted frontend:** signed-in private Studio, dashboard, asset catalog, browser-rendered 3D preview, editors, and previously uploaded analytics/performance captures. The browser must not need a localhost URL, direct access to this PC's filesystem, or Unity running to browse and save drafts.
- **Hosted API + durable storage:** account/project authorization, versioned draft documents, metadata, a persistent command/apply queue, results, and upload manifests. Store source assets, compressed previews, and optional snapshot backups in private blob storage; use short-lived authorized transfers. Do not rely on a serverless process's memory or temporary disk for persistence. Initially support Kingsley as the owner; full collaborative editing is not required.
- **Unity connector:** a small process or Editor service on the Unity computer establishes an authenticated outbound HTTPS connection to the hosted API. Use bounded polling with backoff or supported outbound WebSocket transport; no publicly exposed Editor/MCP port or home-router port forwarding. Reuse the existing local MCP where verified, or bounded Editor APIs. The hosted browser never directly invokes arbitrary MCP/code/filesystem operations.
- **State ownership:** cloud drafts are durable authoring documents; Unity owns actual scene/prefab mutations. Show `Draft saved`, `Pending Unity`, `Applying`, `Applied to Unity`, `Conflict`, and `Failed` distinctly, with last scene-sync time. An Apply request binds a specific draft version and Unity base revision, not a moving latest document. Persist IDs/order, deduplicate retries, reconcile crashes between mutation and acknowledgment, reject stale revisions, and surface conflicts rather than silently overwriting Unity work.
- **When Unity is disconnected:** edit the latest exported scene representation and compatible profiles, organize/import/upload assets, save drafts, and inspect uploaded metrics. Cache current previews; mark missing previews and Unity-only imports/validation as pending. Apply intents remain queued; on reconnect revalidate against current Unity state before execution. Play Mode, authoritative collision/navigation checks, final asset conversion, scene writes, and builds wait for the correct project in Unity. Show stale/unknown data honestly. The hosted API must stay available while the Unity PC is off.
- **Hosting boundary:** ordinary cloud hosting runs the website/API, not a full Unity Editor or Quest build farm. Always-on Unity execution would need a separate compatible machine/host, licensing, and cost review. Existing installed games still need rebuilt content as described below; hosting Studio does not add runtime hot updates.
- **Private access:** HTTPS, owner/project checks on every operation, protected blob access, revocable connector pairing credentials, bounded uploads/requests, origin/CSRF controls as appropriate, and audit records for apply/restore. Store provider credentials in backend secret storage; keep connector credentials on the paired machine. Never ship them to frontend bundles, builds, logs, snapshots, or shared caches. Private raw assets must not become publicly downloadable from the static website.
- **Local-to-cloud deployment:** the initial trusted local Studio includes an owner-only Deploy setup for the chosen host and Name.com. Accept masked credentials into the local backend, validate them read-only, and use an OS credential store or approved secret manager. Build/version only Studio artifacts, show a concrete resource/DNS/cost plan, then let the owner deploy and inspect redacted progress. No browser-persisted secrets, hardcoded IPs, broad public deployment endpoints, or automatic paid provisioning. W01 prepares the build/configuration; W14 implements this deployment flow and post-release checks. Optional tools from the Student Pack are suggestions until selected.

### Hosted performance requirements

Treat these as initial engineering targets to measure, not results already achieved. Record test hardware, browser, network, scene size, and cold/warm cache state.

- Load the dashboard without the 3D engine or scene assets. Split routes/editors; lazy-load thumbnails, audio, animation, and large modules. Initial dashboard first-party compressed JS target: **250 KB or less**, with dependency exceptions justified by measured impact. Initial loading/interactivity targets on the declared test profile: **LCP <= 2.5 s, INP <= 200 ms, CLS <= 0.1**.
- Serve hashed static build assets through the host/CDN with appropriate caching/compression and deployment invalidation. Cache private data by owner/project; never publicly cache authenticated responses, secrets, or source assets. A new deployment must not leave incompatible stale clients silently applying commands.
- Store small thumbnails and optimized preview models/textures separately from full-resolution source files. Download the selected scene/assets on demand; offer preview quality/resolution controls. Deduplicate blobs by content hash within the project, limit concurrent transfers, support retry/resume for large uploads, and avoid bundling asset packs into the app build. Retain originals for Unity import.
- Render a browser scene representation rather than streaming a live Unity desktop by default. Use culling, LOD/instancing where appropriate, bounded texture/GPU memory, background decoding where supported, and resource disposal. Render on change/interaction and pause hidden viewports. Target smooth interaction on the declared desktop test scene, with reduced preview quality when needed; do not infer headset performance from browser FPS.
- Send throttled/debounced incremental edits with revisions; commit a final transform when dragging ends. Do not send whole scenes per mouse move. Paginate/virtualize large catalogs and aggregate analytics on the server. Use bounded background jobs for imports/previews; heavy Unity conversions can wait for the connector instead of exceeding cloud request/CPU limits.
- Measure build size, route loading, viewport frame times, API timings, bytes transferred, repeated-load caching, and reconnect behavior. Show upload/storage quotas and reject excess work gracefully. Verify the actual chosen host's persistence, job, CPU, file-size, and free-tier limits before deployment; no paid cloud GPU assumption.

### Existing Unity MCP — checked 20 October 2026

- Cursor's global `C:\Users\Kingsley\.cursor\mcp.json` configures `unity-mcp` using `C:\Users\Kingsley\.unity\relay\relay_win.exe`. The executable exists; Unity and relay processes were running during inspection. Project `.cursor/mcp.json` has no server entries.
- Installed `com.unity.ai.assistant` **2.20.0-pre.2** includes the `Unity.AI.MCP.Editor` module, `UnityMCPBridge`, and tools including `Unity.ManageScene`, `Unity.ManageGameObject`, and `Unity.ManageAsset`. Source describes named-pipe IPC on Windows. This is evidence of installation/configuration, not a successful tool handshake with this project.
- In W01, use Cursor's existing connection to perform a read-only project/scene query and inspect available tool schemas. Check transport, entitlement/cost, validation, undo, and revision support before reuse. Preserve the user's global configuration and running relays.
- A configured agent MCP connection is not itself a hosted browser API. Reuse supported operations on the Unity machine through the outbound connector when suitable; implement only missing free bridge operations. If MCP is unavailable or requires payment, use the bounded direct Editor bridge. Never expose local IPC or unrestricted tools on the public internet. No second MCP installation or bespoke MCP server is authorized merely by this check.

### Drag-and-drop contract

Use one searchable, typed asset library with provider/category filters and thumbnails. Support dragging library items and files/packs from the current browser's computer into Studio uploads. A source download/upload, preview conversion, and Unity import are distinct states. Place ready preview assets in cloud drafts; queue any required Unity import before apply. Every drop must preview/validate the target, save to the cloud draft, support draft undo, and eventually apply through Unity with its own undo/acknowledgment. Do not label pending imports or draft edits as applied. Provide equivalent click-to-assign controls.

| Asset | Drop target and resulting game change |
| --- | --- |
| 3D model/prefab | Scene surface/hierarchy: place a prop or modular floor/wall piece at the intended scale. Replace selected geometry through an explicit replace action; check colliders, references, and walkability. |
| Texture/material | Selected floor, wall, prop, or material slot: preview/apply a URP-compatible surface, with tiling/offset. Ground meshes use materials; actual Unity Terrain uses validated terrain layers. Clone shared materials by default so one drop does not repaint unrelated objects. |
| 2D/sprite/pixel asset | Scene sprite, supported surface graphic, or compatible UI image slot. Expose sprite-sheet slicing/pixel filtering where relevant; do not pretend a flat image is a 3D model. |
| UI asset | Screen-space or world-space Canvas/image/button art slot, with anchor/size controls. Preserve existing XR interaction and raycast behavior. Asset art does not automatically create gameplay button logic. |
| Audio | Scene emitter or compatible weapon/character/enemy/ambient sound slot. Assign the real clip and preview playback; reject visual-only targets. |
| Animation | Compatible player/character/enemy animation slot or state, with rig validation and preview. Preserve tracked XR camera/controller transforms. |

W02 supplies imports/types, W03 supplies placement/basic assignments, and W07-W09 add full sound/material/animation controls. Unsupported targets must explain the mismatch without changing the scene. Ground/wall edits include both appearance changes and placing/replacing modular geometry, with collision checks; terrain sculpting is not implied.

The Unity Editor owns authoritative scene/prefab/asset changes; cloud draft persistence is separate from acknowledgment that Unity applied the change. Use stable IDs, versioned data, request IDs, revision checks, distinct draft/Unity undo, and explicit save/apply state. Handle main-thread dispatch, domain reloads, disconnects, and conflicting Unity edits. Any local bridge stays on loopback or private IPC behind the authenticated outbound connector. Validate commands on both the API and Unity sides; never allow arbitrary C#, shell execution, or unrestricted filesystem access. Backend secrets use the deployment's secret storage; local development uses ignored server-side config.

Saved changes affect Editor playtests and subsequent builds. An already installed Quest build needs rebuilding/reinstalling unless a separate runtime content update system is approved. No promise of automatic hot updates to shipped games.

Each handoff must include files changed, commands/checks actually run, results, startup steps, and remaining Unity/headset checks. Never claim success from a mock response or browser-only persistence. Do not rewrite unrelated assets or existing user changes.

Kingsley wants **Cursor/Grok -> Codex** takeover when Cursor usage runs out, and **Codex -> Grok** when Codex usage runs out. Follow the checkpoint and takeover protocol in `WORK_PLAN.md`: save intent before each small implementation step, then saved files, exact checks/results, partial work, startup/process details, and the next action afterward. Keep one current checkpoint; do not wait until usage is exhausted. The user triggers the switch after the previous agent stops editing. The receiver reconciles actual files/running operations, updates ownership, and continues the unfinished active task; chat and tool sessions do not automatically transfer. Do not reset work or repeat uncertain Unity mutations.

## W01 — Hosted foundation, durable drafts, and a real Unity connection

**Prompt**

> Build HERTZ Studio's hosted foundation using the shared architecture/performance requirements. Do not clone the supplied screenshots; ship an original polished UI via the installed Shadcn plugin while preserving working W01 API, authentication, connection, draft, and level-editor behavior. Keep one repo and independently deployable web/API code. Implement owner sign-in, persistent cloud-compatible drafts/command results, the Studio shell/routes, dashboard, and Connections with pairing/sync state. Verify Cursor's existing Unity MCP read-only and reuse suitable operations behind an authenticated outbound connector; add only missing bounded Editor operations. Do not require the hosted browser to reach localhost. Prove in a test scene: export state, disconnect Unity, save a draft edit, reconnect, validate the bound base/draft revisions, apply once on Unity's main thread, undo, save, and reopen. Test conflicts and duplicate delivery. Prepare deployment config/instructions for the selected host or document host requirements while no provider is selected. Measure dashboard loading without the 3D bundle. Preserve working scenes. Stop after W01 and record the handoff.

W01 also provides a pending Deploy entry for `hertz.software`/Name.com and the W14 flow. Do not activate optional Student Pack services or treat registrar access as cloud-host access.

**User testing gate:** Kingsley requires a running local preview before W02-W14. After W01 corrections, checks, and independent review, start Studio, verify and share its actual browser URL, leave it running with process/log/restart details, and provide the W01 checklist in `WORK_PLAN.md`. Set `Ready for Kingsley testing`. Fix feedback within W01 and wait for Kingsley's explicit approval before advancing; no hosting or DNS setup is needed for this local test.

**Done when:** a production frontend/API build and durable draft/apply flow work; UI browsing/draft saves continue with Unity disconnected; queued changes apply once after revision checks; undo/reopen persistence works; existing MCP reuse/limits and deployment steps are documented. Test from a second device/hosted URL when a deployment target is available; otherwise mark that check pending, not passed. No secrets or Editor ports are publicly exposed; dashboard loading measurements are recorded.

## W02 — Typed asset library, Kenney packs, and Sketchfab search

**Prompt**

> Build the hosted Asset Library with provider/category filters for 2D, 3D, UI, Audio, Pixel, Textures, and animations. Add typed previews, provenance/license, dependency usage, and separate uploaded/preview-ready/Unity-imported states. Support bounded file/ZIP uploads with safe extraction, resumable large transfers, project-scoped hash deduplication, and private cloud storage. Add Kenney's official category/download workflow and index imported free individual packs; do not invent an API or require the bundle. Integrate documented Sketchfab search/authenticated downloads through the hosted backend, retaining credits and checking current access. Handle glTF/GLB/USDZ with a justified free Unity importer on the connector. Keep heavyweight imports pending when Unity is off. Use lazy thumbnails, paginated results, quotas, progress/cancellation, and actionable provider/import errors. Stop after W02.

**Done when:** samples of all six Kenney categories import, retain provenance, preview appropriately, survive restart, and become typed draggable library entries; a permitted model becomes a Unity prefab. Verify Sketchfab with real access when available and label any untested provider path. Duplicate pack imports do not create uncontrolled copies.

## W03 — Drag-and-drop level editor

**Prompt**

> Build the level editor from reference 02 using cloud drafts, exported scene previews, the connector, and the shared drop contract. Lazy-load geometry and use bounded preview textures/LOD. Support typed model/surface/sprite/UI/audio drops, selection, transform/snapping, duplicate, explicit geometry replacement, remove, draft undo/redo, cloud save/reload, and explicit Apply/Unity playtest. Continue authoring the latest preview while Unity is disconnected; display last-sync time and pending Unity validation. Throttle incremental drag updates and finalize on release; never upload a full scene per movement. Preserve units/pivots, prefab links, material slots, and unrelated shared materials. Conflict-check Unity revisions. Validate colliders/walkability on apply; show pending or stale collision/navigation data honestly. Do not move the XR rig. Stop after W03.

**Done when:** each supported asset type changes the correct Unity target, undo/reopen work, and invalid drops leave the scene intact. Replace a floor/wall piece and apply distinct surface textures in a test scene; verify player collision and no unintended material changes. Browser placement agrees with Unity for rotated/scaled objects.

## W04 — Weapon catalog and tuning

**Prompt**

> Build the weapon catalog/editor using reference 03. Add/import, preview, rename, assign/replace models, enable/disable, and remove catalog entries with dependency checks. Expose validated properties actually consumed by gameplay, including applicable damage, fire interval, range, recoil, and hand/grip/muzzle anchors. Keep the game's dual-pistol loadout and frequency-flip gate intact; catalog imports must not automatically equip new weapon types. Persist definitions as Unity assets and connect them to runtime consumers. Where consumers are missing, implement the smallest required binding and an isolated playable verification scene; list remaining gameplay dependencies. Provide a simple playtest for tuning and validate invalid values. Do not copy rarity, currency, shop, or unlock systems from the screenshots. Stop after W04.

**Done when:** model/tuning edits affect the runtime pistol test, restart persistence works, disabling/removing a referenced entry is handled safely, and frequency gating remains enforced.

## W05 — Character models and enemy AI controls

**Prompt**

> Build Characters & Enemies using the shared visual language. Support add/import, preview, replace, enable/disable, and remove player/character and enemy models. Validate rig/avatar compatibility, scale, animation assignments, colliders, and references; do not replace the tracked XR rig/camera with an imported character. Enemy profiles need editable movement speed, detection and attack ranges, wait/reaction delay before firing, shot/burst interval, approach distance, and idle/patrol/hold-position/rush behavior where applicable. Separate visual models from behavior profiles. Implement and bind the requested behaviors where absent, with visible validation and an isolated Unity playtest for hold/wait/fire and rush/stop/attack. Inspect navigation support before choosing a free movement solution. Save as versioned Unity assets; changes must reach runtime, including existing frequency targeting rules. Do not invent enemy species or add encounters to the main scene. Stop after W05.

**Done when:** model swaps persist, character safety checks work, and changing wait time or rush behavior produces observable behavior in the Unity test. Referenced model/profile removal cannot silently break a scene.

## W06 — Real game analytics with hosted readouts

**Prompt**

> Build hosted Analytics and real dashboard values from a documented event schema with build/session/level/time and relevant weapon/enemy IDs. Instrument the approved playtest events: session/level start/end, frequency flips, shots/hits, and enemy defeats. Batch local capture, then upload selected captures through the connector or authenticated browser import; deduplicate retries/imports. Store private owner-scoped data and server-side aggregates so readouts remain available with Unity off. Show sessions, duration, completion, accuracy, weapon usage, and frame-time summaries with date/build/level filters, sample counts, denominator/incomplete-session rules, and CSV/JSON export. Keep payloads bounded/paginated; never send all raw events just to draw a summary. Explain Quest capture transfer. No personal identifiers, public-player collection expansion, fabricated metrics, or fixture mixing. Stop after W06.

**Done when:** a recorded playtest populates correct metrics, repeated import does not double-count, filters work, and dashboard values can be traced to recorded events. Device collection remains unverified until tested on Quest.

## W07 — Sound editor and Kenney audio

**Prompt**

> Build the Sound editor using imported Kenney/local audio. Support search, audition, drag-to-assign, and removal with usage checks for weapon, enemy, character, ambience, and footstep sound slots. Create/edit scene emitters with volume, loop, spatial blend, and attenuation controls. Use explicit surface-to-footstep mappings where gameplay supports footsteps; material appearance alone must not silently change sound logic. Bind saved assignments to runtime consumers and add minimal hooks where absent. Preserve VR audio comfort and prevent overlapping audition playback. Keep source/license metadata and show unsupported files clearly. Stop after W07.

**Done when:** an assigned clip plays from the intended runtime event/emitter, spatial and loop settings persist, and undo/removal/dependency checks work. Validate a Kenney clip and a floor surface mapping in the test scene.

## W08 — Poly Haven, ground/wall surfaces, and lighting

**Prompt**

> Add Poly Haven browsing/search for textures, HDRIs, and models using its documented free API, identifying User-Agent, provider credit, caching, and resolution selection. Feed downloads into the typed library. Build surface controls for floors, walls, props, and actual Terrain layers: drop-to-apply, material-slot selection, tiling/offset, normal strength, and relevant URP shading parameters. Correctly map PBR textures, color spaces, roughness/smoothness, and channel packing; do not assume provider maps directly match Unity inputs. Duplicate shared materials unless an explicit shared edit is chosen. Support HDRI/environment and existing light controls with browser/Unity preview limitations shown. Keep Quest-friendly import defaults and visible texture sizes; do not introduce expensive realtime lighting by default. Stop after W08.

**Done when:** a Poly Haven surface changes a floor and a different wall independently, survives reopen, and undoes correctly; Terrain layers are validated on a real Terrain test target. An HDRI import/environment change works in Unity, with preview differences documented.

## W09 — Mixamo animation editor for characters and enemies

**Prompt**

> Add Mixamo's free Adobe-ID workflow: open Mixamo for rigging/animation selection, then import downloaded FBX files into Studio by file/pack drag-and-drop. Do not invent a Mixamo API, automate user sign-in, or require a paid subscription. Build animation preview and compatible character/enemy slots for idle, locomotion, attack/shoot, and other existing runtime states. Support assign/replace, loop, speed, transition timing, and an explicit root-motion policy. Validate Unity Humanoid avatars/retargeting; explain unsupported non-humanoid rigs and retain existing compatible clips. Bind enemy movement/attack states to the saved selections. Support the player's visible compatible character model without animating tracked camera/controllers or taking over XR locomotion. Stop after W09.

**Done when:** imported Mixamo clips preview and run on compatible enemy and player-character test models, saved assignments persist, and rig mismatches produce actionable errors. Verify wait/rush/attack transitions and no tracked-transform overrides.

## W10 — Quest performance inspector

**Prompt**

> Build a Quest-focused Performance inspector using Unity/project data and authenticated upload/import of local captures. Store private summaries so reports remain available when Unity is off; show capture time/build/device and stale scene revisions. Separate static estimates, Editor measurements, and Quest 3S measurements. Show supported CPU/GPU frame times, FPS, draw calls/batches, triangles, texture memory, material/light counts, and LOD indicators; mark unavailable counters honestly. Use the actual refresh rate and document units/scope. Link findings to assets/objects. Keep capture/upload sampled, batched, and bounded; aggregate server-side and paginate history. Provide an on-device measurement procedure. Preserve headset-independent runtime behavior and isolate vendor-specific metrics. Keep browser viewport performance separate from headset performance. No automatic optimization changes. Stop after W10.

**Done when:** static findings trace to real assets, captures retain device/build/scene identity, and unsupported counters are clear. Verify an available local capture; mark Quest results pending until a device capture is actually inspected.

## W11 — Local snapshots, diffs, and rollback

**Prompt**

> Build named local Unity snapshots plus hosted draft history and optional private snapshot backup/sync. Capture selected scenes, owned prefabs/materials/profiles, animation/sound/encounter bindings, dependencies, and matching .meta/GUIDs in a hashed manifest. Exclude secrets/logs/Library/Temp/unrelated work. Clearly distinguish cloud draft rollback from restoring Unity files. View history/diffs remotely; queue an explicitly selected snapshot restore if Unity is disconnected and require fresh revision validation before execution. Use staged writes, a pre-restore safety snapshot, recovery, and reference checks. Deduplicate backup blobs instead of uploading the whole project each time; show storage/retention limits and backups not yet uploaded. Never use git reset/clean or delete unrelated changes. Keep local storage outside Assets. Stop after W11.

**Done when:** edit a surface/model/profile, compare with a snapshot, and restore the captured state after reopening. GUIDs/references survive, an incomplete/corrupt snapshot is rejected, and a failed restore can recover without losing later unrelated changes.

## W12 — Visual encounter and timing editor

**Prompt**

> Build an encounter editor combining scene spawn placement with a visual timeline. Drag existing enemy profiles/prefabs into spawn points and sequence events by delay or approved triggers. Expose counts, timing, spacing, behavior profile, start/completion conditions, and links to existing frequency/level events. Reuse animation/audio/profile bindings and show missing references or unsupported triggers. Persist versioned encounter assets and implement the minimal runtime scheduler/hooks where absent. Add timeline preview, play/pause/reset for an isolated test, undo/redo, and snapshot integration. Validate negative times, impossible references, duplicate execution, cancellation, and unreachable spawns. Do not invent story chapters/enemy types or overwrite working encounters; let Kingsley place/select content. Stop after W12.

**Done when:** moving a spawn point or changing a timeline delay changes the Unity encounter test as expected, save/reload works, reset does not duplicate spawns, and invalid references are caught before play.

## W13 — Integration checks and usable handoff

**Prompt**

> Verify hosted HERTZ Studio end to end: all six Kenney categories, Sketchfab/Poly Haven imports, typed drops and ground/walls, tuning, Mixamo/audio, encounter timing, analytics/performance, and snapshot/restore. Test from a second device/hosted URL when a target exists: browse/save drafts with Unity PC disconnected, reconnect, revision-check and apply once, then save/reopen Unity. Test server/connector restart, lost acknowledgment, duplicate delivery, conflicts, expired auth, invalid drops, provider failure, quotas, and secret/private-asset access. Measure production route/build sizes, cold/warm loading, editor frame times, API latency and transfer bytes; repair regressions against shared targets. Confirm deployment excludes Unity source/build caches and Editor code is excluded from player assemblies. Document deployment, pairing/revocation, free-tier limits, captures, backups/recovery, and game rebuild requirements. Mark unavailable hosting/device tests pending. Stop for review.

**Done when:** requested modules work together with durable hosted drafts and safe delayed Unity apply, deployment/performance checks have actual recorded results, and recovery plus remaining manual checks are reproducible. Do not claim remote-host operation from localhost-only testing.

## Approval record and remaining options

Approved by Kingsley on 20 October 2026: **S1** Poly Haven/materials/lighting -> W08; **S2** Mixamo -> W09; **S3** Kenney expanded to all six categories + sound -> W02/W03/W07; **S5** performance -> W10; **S6** snapshots -> W11; **S7** encounter/timing -> W12. These are part of the requested product; do not ask for the same approval again. Selecting the next active task still follows `WORK_PLAN.md`.

**S4 Blender integration** remains optional and unapproved. **S8 a new custom MCP adapter** remains optional; Kingsley authorized inspecting/reusing the existing Unity MCP, not installing a second server. No optional integration may become a required dependency. Meshy and credit-based generators remain excluded.

The local Deploy page, domain setup, and cloud deployment capability are approved in W14. The [Student Pack research shortlist](STUDENT_PACK_OPTIONS.md) is awaiting selections; Heroku, Clerk, Sentry, Doppler, BrowserStack, and other offers are not automatically mandatory integrations. A provider must be chosen and its actual redeemed benefits/allowed use verified before provisioning.

## W14 — Deploy from local Studio to studio.hertz.software

**Confirmed production URL:** `https://studio.hertz.software`, selected by Kingsley on 20 October 2026. Default the Deploy UI, production allowed origins, authentication callbacks, and connector configuration to this address as appropriate. Preserve the root domain and unrelated DNS records. Hosting-provider selection remains open.

**Prompt**

> Build the owner-only local Deploy page for HERTZ Studio. Use the selected hosting provider and Name.com; verify current API/auth capabilities first and implement one host path, not every Student Pack option. Accept masked host and DNS credentials into a trusted local backend, test account/domain access read-only, and persist secrets only in the OS credential store or an approved secret manager. Show a concrete deployment preview: artifact/version, target account, chosen hertz.software hostname, resources, verified credit/quota/expiry, estimated charges, DNS changes, and migration/rollback steps. On Deploy, build/test only Studio artifacts, provision only the reviewed configuration, publish, bind the domain, and verify HTTPS/sign-in/API/storage/connector access from another device. Preserve unrelated DNS records; provide exact manual records if Name.com API access is unavailable. Handle failed builds, expired tokens, partial provisioning, DNS propagation, redacted logs, and rollback without deleting data. Keep broad deploy tokens local; configure runtime secrets at the host. Do not exceed free/verified credit limits. Stop and record results.

**Done when:** a real selected-provider deployment reaches the chosen hostname through this UI, account/credit checks and secret handling are verified, and post-release checks plus rollback are documented. Without selected host/credentials, finish the reviewable implementation/configuration and explicitly mark live deployment/DNS checks pending; never call a fake provider response success. Domain purchase or a Name.com token alone does not satisfy cloud hosting setup.

The cost preview must distinguish an enforced spending stop from an estimate/alert. Do not promise that remaining student credits prevent all provider charges; show expiry and any unsupported billing cap before the deployment is selected.

## Technical references

- [MDN lazy loading](https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/Lazy_loading), [WebGL performance](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices): deferred editor resources and bounded GPU work.
- [Cloudflare static serving/caching](https://developers.cloudflare.com/pages/configuration/serving-pages/), [queue delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/): examples of host caching and retry/deduplication constraints, not a hosting selection. [R2 pricing](https://developers.cloudflare.com/r2/pricing/) illustrates finite free storage/operation allowances; no paid storage service is selected.
- [Kenney assets](https://kenney.nl/assets), [Kenney license FAQ](https://kenney.nl/support): six asset categories and CC0 licensing; use free individual packs and retain pack metadata.
- [Adobe Mixamo FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html): free with an Adobe ID, game usage, and humanoid rig constraints.
- [Poly Haven API](https://polyhaven.com/our-api): current free commercial API, provider credit, identifying User-Agent, asset metadata/downloads; [API repository](https://github.com/Poly-Haven/Public-API).
- [Sketchfab Download API](https://sketchfab.com/developers/download-api): documented authentication requirements and supported download formats; verify access during W02.
- [Unity 6.0 Undo](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/Undo.html), [Editor scene saving](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/SceneManagement.EditorSceneManager.SaveScene.html): verify against the installed Editor before use.
