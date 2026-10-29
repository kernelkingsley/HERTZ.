/**
 * Curated W0x implementation detail summaries for the Milestones detail view.
 * Proof counts are loaded live from Tools/HertzStudio/data when present.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function defaultDataDir() {
  if (process.env.HERTZ_STUDIO_DATA) return path.resolve(process.env.HERTZ_STUDIO_DATA);
  return path.resolve(__dirname, "../data");
}

function readProofSummary(dataDir, fileName) {
  const p = path.join(dataDir, fileName);
  if (!fs.existsSync(p)) {
    return { file: fileName, present: false, ok: false, passed: 0, total: 0, proof: null };
  }
  try {
    let text = fs.readFileSync(p, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const j = JSON.parse(text);
    return {
      file: fileName,
      present: true,
      ok: j.ok === true,
      passed: Number(j.passed) || 0,
      total: Number(j.total) || (Array.isArray(j.checks) ? j.checks.length : 0),
      proof: j.proof || null,
      stampedAt: j.stampedAt || null,
    };
  } catch (e) {
    return { file: fileName, present: true, ok: false, passed: 0, total: 0, error: String(e.message || e) };
  }
}

const CURATED = {
  W01: {
    title: "Studio shell + drafts",
    statusNote: "Placeholder detail — expand when revisiting W01 archive.",
    features: ["Owner auth", "Studio shell", "Durable drafts", "Connections pairing"],
    files: [],
    assets: [],
    behavioralChanges: [],
    proofFiles: [],
    placeholder: true,
  },
  W02: {
    title: "Typed asset library",
    statusNote: "Placeholder detail — expand when revisiting W02 archive.",
    features: ["Asset library", "Kenney packs", "Sketchfab search"],
    files: [],
    assets: [],
    behavioralChanges: [],
    proofFiles: [],
    placeholder: true,
  },
  W03: {
    title: "Drag-and-drop level editor",
    statusNote: "Cloud drafts, typed drops, Apply/Unity sync, walkability.",
    features: [
      "Browser level editor with cloud drafts",
      "Typed drops (model/material/sprite/UI/audio/animation)",
      "Transform/gizmo commits + draft undo",
      "Atomic Unity Apply with revision binding",
      "Walkability / collider validation",
      "Offline authoring with reconnect",
    ],
    files: [
      "Tools/HertzStudio/web/src/pages/LevelEditor.jsx",
      "Tools/HertzStudio/web/src/pages/LevelEditorViewport.jsx",
      "Tools/HertzStudio/api/src/draft-commands.mjs",
      "Tools/HertzStudio/api/src/walkability.mjs",
      "Assets/Editor/HertzStudio/HertzStudioSceneCommands.cs",
      "Assets/Editor/HertzStudio/HertzStudioHttpBridge.cs",
      "Assets/Scenes/HertzStudioTest.unity",
    ],
    assets: [
      "HertzStudioTest scene seeds",
      "HertzStudioSurfaceKind markers",
      "Typed-ops proof artifacts under data/w03-*-proof.json",
    ],
    behavioralChanges: [
      "Invalid typed drops leave draft/scene intact",
      "Apply binds draft version + Unity base revision",
      "XR rig / Main Camera protected from replace",
      "replace_floor_wall preserves project MonoBehaviours",
    ],
    proofFiles: [
      "w03-aggregate-proof.json",
      "w03-browser-e2e-proof.json",
      "w03-typed-ops-proof.json",
      "w03-completion-batch-proof.json",
      "w03-hash-proof.json",
    ],
    placeholder: false,
  },
  W04: {
    title: "Weapon catalog and tuning",
    statusNote: "Dual pistols + frequency gate; isolated HertzWeaponTest.",
    features: [
      "Weapon catalog with model picker and tuning",
      "Idempotent Unity ScriptableObject sync",
      "HertzDualPistolRuntime left/right binding",
      "Frequency-gated fire (off until flip)",
      "Hitscan FX pool + optional sound boundary",
      "Dependency-safe delete / Unity-acked delete",
    ],
    files: [
      "Tools/HertzStudio/web/src/pages/Weapons.jsx",
      "Tools/HertzStudio/api/src/weapons.mjs",
      "Assets/Scripts/Weapons/HertzDualPistolRuntime.cs",
      "Assets/Scripts/Weapons/HertzFrequencyGate.cs",
      "Assets/Editor/HertzStudio/HertzStudioWeaponCommands.cs",
      "Assets/Editor/HertzStudio/HertzStudioWeaponProof.cs",
      "Assets/Scenes/HertzWeaponTest.unity",
    ],
    assets: [
      "W04_Test_LeftPistol / W04_Test_RightPistol definitions",
      "PLACEHOLDER pistol prefabs under HertzStudio/Weapons/TestAssets",
      "data/w04-*-proof.json",
    ],
    behavioralChanges: [
      "Firing blocked while frequency inactive",
      "Left/right roles cannot silently collapse",
      "Saved HertzWeaponTest has zero *_Runtime clones",
      "poll-weapons preserves delete vs sync job type",
    ],
    proofFiles: [
      "w04-aggregate-proof.json",
      "w04-browser-e2e-proof.json",
      "w04-frequency-runtime-proof.json",
      "w04-weapon-definition-sync-proof.json",
    ],
    placeholder: false,
  },
  W05: {
    title: "Characters & Enemies",
    statusNote: "Models vs profiles; hold/rush AI; animation slots + preview; milestone details.",
    features: [
      "Character models separate from enemy behavior profiles",
      "XR-rig replace hard-rejected",
      "Transform-seek hold wait→fire and rush stop→attack",
      "Frequency-gated HertzSpiritTarget",
      "Idle/attack/locomotion animation slot assignment",
      "Truthful Characters preview (exact embedded clip only; Unity-only shown unavailable)",
      "Unity bridge /characters/validate-animation for authoritative rig compatibility",
      "Milestones detail breakdown (this view)",
    ],
    files: [
      "Tools/HertzStudio/web/src/pages/Characters.jsx",
      "Tools/HertzStudio/web/src/components/CharacterPreview.jsx",
      "Tools/HertzStudio/web/src/lib/characterPreviewAnimation.js",
      "Tools/HertzStudio/api/src/characters.mjs",
      "Tools/HertzStudio/shared/milestoneDetails.mjs",
      "Assets/Scripts/Characters/HertzCharacterDefinition.cs",
      "Assets/Scripts/Characters/HertzEnemyBehaviorProfile.cs",
      "Assets/Scripts/Characters/HertzEnemyAgent.cs",
      "Assets/Scripts/Characters/HertzSpiritTarget.cs",
      "Assets/Editor/HertzStudio/HertzStudioCharacterProof.cs",
      "Assets/Scenes/HertzCharacterTest.unity",
    ],
    assets: [
      "W05_Test_Hold / W05_Test_Rush profiles",
      "Assets/HertzStudio/Characters/{Models,Profiles,TestAssets}",
      "data/w05-*-proof.json",
    ],
    behavioralChanges: [
      "Hold enemies wait then fire without moving",
      "Rush enemies approach then stop within approach distance before firing",
      "Spirits only targetable/damageable when frequency is on",
      "SampleScene never receives invented encounters",
    ],
    proofFiles: [
      "w05-aggregate-proof.json",
      "w05-character-behavior-proof.json",
      "w05-character-sync-proof.json",
    ],
    placeholder: false,
  },
  W06: {
    title: "Real game analytics",
    statusNote: "Hosted Analytics from documented playtest events; Quest transfer documented only.",
    features: [
      "Documented event schema (session/level/frequency/shot/defeat/frame)",
      "Unity HertzAnalyticsCapture batch export",
      "Browser import + connector pending-capture upload with eventId dedupe",
      "Owner-scoped durable storage + server aggregates (Unity off OK)",
      "Analytics page filters, sample counts, CSV/JSON export",
      "Quest capture transfer guide (device collection unverified)",
    ],
    files: [
      "Tools/HertzStudio/api/src/analytics.mjs",
      "Tools/HertzStudio/web/src/pages/Analytics.jsx",
      "Tools/HertzStudio/connector/src/connector.mjs",
      "Assets/Scripts/Analytics/HertzAnalyticsCapture.cs",
      "Assets/Editor/HertzStudio/HertzStudioAnalyticsProof.cs",
      "Assets/Editor/HertzStudio/HertzStudioHttpBridge.cs",
    ],
    assets: [
      "data/w06-sample-capture.json",
      "data/w06-aggregate-proof.json",
      "data/analytics/ (owner-scoped captures)",
    ],
    behavioralChanges: [
      "Shot events carry hit flags — no separate hit rows in Unity exporter",
      "Repeated import of the same eventIds does not double-count metrics",
      "Dashboard values are server aggregates, not fabricated fixtures mixed into live data",
    ],
    proofFiles: ["w06-aggregate-proof.json"],
    placeholder: false,
  },
  W07: {
    title: "Sound editor and Kenney audio",
    statusNote: "Slots, emitters, explicit footsteps; runtime proof requires unity_editor_menu (no node fallback).",
    features: [
      "Sound editor at /sound with Kenney/local library search",
      "Single non-overlapping browser audition (AudioPreview)",
      "Drag/assign weapon/enemy/character/ambience slots",
      "Scene emitters with volume/loop/spatial/attenuation",
      "Explicit footstep surface mappings (no material auto-bind)",
      "Usage dependency checks + Unity sound board sync",
      "Runtime shot presenter + footstep player hooks",
      "Aggregate proof layers: API vs connector vs Unity vs Play Mode (fallback never counts as runtime pass)",
    ],
    files: [
      "Tools/HertzStudio/api/src/sound.mjs",
      "Tools/HertzStudio/web/src/pages/Sound.jsx",
      "Tools/HertzStudio/connector/src/connector.mjs",
      "Assets/Scripts/Sound/HertzWeaponShotClipPresenter.cs",
      "Assets/Scripts/Sound/HertzSoundEmitter.cs",
      "Assets/Scripts/Sound/HertzFootstepSurfaceMap.cs",
      "Assets/Editor/HertzStudio/HertzStudioSoundCommands.cs",
    ],
    assets: [
      "Assets/HertzStudio/Sound/",
      "data/w07-aggregate-proof.json",
      "data/w07-sound-runtime-proof.json",
    ],
    behavioralChanges: [
      "Accepted pistol shots can play assigned clips via IHertzWeaponShotAudioPresenter",
      "Footstep playback resolves by explicit surfaceId only",
      "Material appearance changes do not rewrite footstep mappings",
    ],
    proofFiles: ["w07-aggregate-proof.json", "w07-sound-runtime-proof.json"],
    placeholder: false,
  },
};

const FUTURE_IDS = ["W08", "W09", "W10", "W11", "W12", "W13", "W14"];

for (const id of FUTURE_IDS) {
  CURATED[id] = {
    title: id,
    statusNote: "Not started / queued — detail will appear when this milestone ships.",
    features: [],
    files: [],
    assets: [],
    behavioralChanges: [],
    proofFiles: [],
    placeholder: true,
  };
}

export function getMilestoneDetail(id, dataDir = defaultDataDir()) {
  const curated = CURATED[id];
  if (!curated) {
    const err = new Error(`Unknown milestone id: ${id}`);
    err.code = "invalid_milestone";
    throw err;
  }
  const proofs = (curated.proofFiles || []).map((f) => readProofSummary(dataDir, f));
  const proofPassed = proofs.reduce((n, p) => n + (p.ok ? 1 : 0), 0);
  return {
    id,
    title: curated.title,
    statusNote: curated.statusNote,
    placeholder: Boolean(curated.placeholder),
    features: [...(curated.features || [])],
    files: [...(curated.files || [])],
    assets: [...(curated.assets || [])],
    behavioralChanges: [...(curated.behavioralChanges || [])],
    proofs,
    proofSummary: {
      present: proofs.filter((p) => p.present).length,
      ok: proofPassed,
      total: proofs.length,
    },
  };
}

export function listMilestoneDetailIds() {
  return Object.keys(CURATED);
}
