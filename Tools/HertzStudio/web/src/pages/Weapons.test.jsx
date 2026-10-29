import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Weapons, { wrapperNeedsStudioConfirm } from "./Weapons.jsx";

vi.mock("../api.js", () => ({
  api: vi.fn(),
}));

vi.mock("../lib/milestoneStatus.js", () => ({
  getMilestoneStatus: () => "In progress",
  statusBadgeVariant: () => "secondary",
}));

import { api } from "../api.js";

const leftId = "11111111-1111-4111-8111-111111111111";
const rightId = "22222222-2222-4222-8222-222222222222";

function baseWeapon(overrides = {}) {
  return {
    id: leftId,
    displayName: "Left Pistol",
    role: "left_pistol",
    enabled: true,
    frequencyFlipRequired: true,
    version: 1,
    modelAssetId: null,
    tuning: {
      damage: 10,
      fireIntervalSeconds: 0.2,
      rangeMeters: 40,
      recoil: 0.15,
      leftHandAnchor: "LeftHand",
      rightHandAnchor: "RightHand",
      gripAnchor: "Grip",
      muzzleAnchor: "Muzzle",
    },
    unitySync: { state: "disconnected" },
    ...overrides,
  };
}

function renderWeapons() {
  cleanup();
  return render(
    <MemoryRouter>
      <Weapons />
    </MemoryRouter>,
  );
}

describe("Weapons UI", () => {
  let weaponsState;
  let loadoutState;

  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    cleanup();
    api.mockReset();
    weaponsState = [];
    loadoutState = {
      frequencyFlipRequired: true,
      slots: ["left_pistol", "right_pistol"],
      leftWeaponId: null,
      rightWeaponId: null,
      note: "Catalog imports never auto-equip.",
    };

    api.mockImplementation(async (path, opts = {}) => {
      if (path === "/api/weapons") {
        return { loadout: loadoutState, weapons: weaponsState };
      }
      if (path === "/api/unity/scenes") {
        return { scenes: [] };
      }
      if (path === "/api/sound") {
        return { slots: [] };
      }
      if (
        String(path).startsWith("/api/weapons/models/library") ||
        String(path).startsWith("/api/weapons/models/ready")
      ) {
        return {
          models: [
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              modelAssetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              displayName: "Ready Pistol",
              assetType: "model_3d",
              state: "unity_imported",
              stateLabel: "Unity imported",
              assignable: true,
              unityImported: true,
              browserPreviewReady: true,
              canEnqueueImport: false,
              canRetryImport: false,
              importInFlight: false,
              unity: { readiness: "ready" },
            },
            {
              id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              modelAssetId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              displayName: "Preview Only",
              assetType: "model_3d",
              state: "preview_ready",
              stateLabel: "Preview ready",
              assignable: false,
              unityImported: false,
              browserPreviewReady: true,
              canEnqueueImport: true,
              canRetryImport: false,
              importInFlight: false,
              blockReason: "Preview ready in browser only — Import to Unity before assigning.",
            },
          ],
        };
      }
      if (opts.method === "POST" && path === "/api/weapons") {
        const body = JSON.parse(opts.body || "{}");
        if (body.id && body.expectedVersion != null && Number(body.expectedVersion) !== 1) {
          const err = new Error("Stale weapon version");
          err.data = { code: "stale_version" };
          throw err;
        }
        const id = body.id || (body.role === "right_pistol" ? rightId : leftId);
        const created = baseWeapon({
          id,
          displayName: body.displayName || "Created",
          role: body.role || "left_pistol",
          version: body.id ? 2 : 1,
          modelAssetId: body.modelAssetId || null,
        });
        weaponsState = [...weaponsState.filter((w) => w.id !== created.id), created];
        return created;
      }
      if (opts.method === "POST" && /\/sync$/.test(path)) {
        const id = path.split("/")[3];
        weaponsState = weaponsState.map((w) =>
          w.id === id
            ? {
                ...w,
                unitySync: {
                  state: "queued",
                  lastRequestId: "req-ui-1",
                },
              }
            : w,
        );
        return { requestId: "req-ui-1", status: 202 };
      }
      if (opts.method === "PATCH" && path === "/api/weapons/loadout") {
        const body = JSON.parse(opts.body || "{}");
        loadoutState = { ...loadoutState, ...body };
        return loadoutState;
      }
      if (opts.method === "DELETE" && String(path).startsWith("/api/weapons/")) {
        const url = new URL(path, "http://local");
        const id = url.pathname.split("/").pop();
        weaponsState = weaponsState.filter((x) => x.id !== id);
        return { ok: true, deleted: true, note: "Catalog entry removed. Model assets left intact." };
      }
      if (String(path).includes("/dependencies")) {
        const id = String(path).split("/")[3];
        const w = weaponsState.find((x) => x.id === id);
        if (w?.unitySync?.assetGuid) {
          return {
            exists: true,
            dependencies: [
              {
                kind: "unity_mapping",
                detail: "Unity definition mapping exists.",
                assetPath: w.unitySync.assetPath || "Assets/HertzStudio/Weapons/Definitions/x.asset",
              },
            ],
            actions: {
              unassignLoadoutLeft: false,
              unassignLoadoutRight: false,
              cancelQueuedSyncAndRemove: false,
              refreshStatus: false,
              deleteUnityAndRemove: true,
              retainUnityAndRemove: true,
              removeNow: false,
            },
            nextAction:
              "Delete Unity definition and remove (waits for Unity ack), or Keep Unity definition and remove catalog entry.",
            preserves: { assetLibraryModel: true },
          };
        }
        if (w?.unitySync?.state === "queued") {
          return {
            exists: true,
            dependencies: [
              { kind: "sync_job", detail: "sync_weapon_definition pending_unity", status: "pending_unity" },
              { kind: "unity_sync_state", detail: "unitySync.state=queued", state: "queued" },
            ],
            actions: {
              cancelQueuedSyncAndRemove: true,
              deleteUnityAndRemove: false,
              retainUnityAndRemove: false,
              refreshStatus: false,
              removeNow: false,
            },
            nextAction: "Cancel queued sync and remove (Unity offline is OK — the job was never delivered).",
          };
        }
        return {
          exists: true,
          dependencies: [],
          actions: { removeNow: true },
          nextAction: "No blockers — confirm Remove to delete the catalog entry only.",
        };
      }
      if (opts.method === "POST" && String(path).includes("/guided-remove")) {
        const id = String(path).split("/")[3];
        const body = JSON.parse(opts.body || "{}");
        if (body.action === "retain_unity_and_remove" || body.action === "cancel_queued_and_remove" || body.action === "remove_now") {
          weaponsState = weaponsState.filter((x) => x.id !== id);
          return {
            ok: true,
            deleted: true,
            status: "completed",
            action: body.action,
            note: "Catalog entry removed. Linked Asset Library model preserved.",
          };
        }
        if (body.action === "refresh" || body.action === "preview") {
          return {
            ok: true,
            action: body.action,
            dependencies: [],
            actions: { removeNow: true },
          };
        }
        return { ok: true, status: "queued", action: body.action };
      }
      if (opts.method === "POST" && String(path).includes("/unity-delete")) {
        return { requestId: "req-del", status: 202 };
      }
      return {};
    });
  });

  it("shows frequency flip, model picker, and filters ready models", async () => {
    renderWeapons();
    await waitFor(() => expect(screen.getByTestId("weapons-page")).toBeInTheDocument());
    expect(screen.getByTestId("frequency-flip-required")).toHaveTextContent(/yes/i);
    expect(screen.getByTestId("model-picker")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("model-select")).toBeInTheDocument());
    expect(screen.getByRole("option", { name: /Ready Pistol/i })).toBeInTheDocument();
    expect(screen.getByTestId("placeholder-content-note")).toHaveTextContent(/PLACEHOLDER|Sound section/i);
    expect(screen.getByTestId("weapons-milestone-badge")).toHaveTextContent(/in progress/i);
  });

  it("empty model library still allows create without model", async () => {
    api.mockImplementation(async (path, opts = {}) => {
      if (path === "/api/weapons") return { loadout: loadoutState, weapons: [] };
      if (path === "/api/unity/scenes") return { scenes: [] };
      if (path === "/api/sound") return { slots: [] };
      if (
        String(path).startsWith("/api/weapons/models/library") ||
        String(path).startsWith("/api/weapons/models/ready")
      ) {
        return { models: [] };
      }
      if (opts.method === "POST" && path === "/api/weapons") {
        return baseWeapon({ displayName: "No Mesh Yet", modelAssetId: null });
      }
      return {};
    });
    renderWeapons();
    await waitFor(() => expect(screen.getByTestId("model-select")).toBeInTheDocument());
    expect(screen.queryByRole("option", { name: /Ready Pistol/i })).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("weapon-name"), { target: { value: "No Mesh Yet" } });
    fireEvent.click(screen.getByTestId("weapon-save"));
    await waitFor(() => expect(screen.getByTestId("weapons-message")).toBeInTheDocument());
  });

  it("create/update dirty state and stale-version conflict", async () => {
    weaponsState = [baseWeapon()];
    renderWeapons();
    await waitFor(() => expect(screen.getByTestId("weapon-row-left_pistol")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("weapon-row-left_pistol"));
    await waitFor(() => expect(screen.getByTestId("weapon-name")).toHaveValue("Left Pistol"));
    fireEvent.change(screen.getByTestId("weapon-name"), { target: { value: "Edited Name" } });
    expect(screen.getByTestId("weapon-save")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("weapon-save"));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/weapons",
        expect.objectContaining({ method: "POST" }),
      ),
    );

    api.mockImplementation(async (path, opts = {}) => {
      if (path === "/api/weapons" && opts.method !== "POST") {
        return { loadout: loadoutState, weapons: weaponsState };
      }
      if (path === "/api/unity/scenes") return { scenes: [] };
      if (path === "/api/sound") return { slots: [] };
      if (
        String(path).startsWith("/api/weapons/models/library") ||
        String(path).startsWith("/api/weapons/models/ready")
      ) {
        return { models: [] };
      }
      if (opts.method === "POST" && path === "/api/weapons") {
        const err = new Error("Stale weapon version");
        err.data = { code: "stale_version" };
        throw err;
      }
      return {};
    });
    fireEvent.change(screen.getByTestId("weapon-name"), { target: { value: "Conflict Edit" } });
    fireEvent.click(screen.getByTestId("weapon-save"));
    await waitFor(() => expect(screen.getByTestId("weapons-error")).toHaveTextContent(/stale/i));
  });

  it("loadout assign and sync queued status", async () => {
    weaponsState = [baseWeapon()];
    renderWeapons();
    await waitFor(() => expect(screen.getByTestId("weapon-row-left_pistol")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("weapon-row-left_pistol"));
    fireEvent.click(screen.getByTestId("weapon-assign-loadout"));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/weapons/loadout",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    fireEvent.click(screen.getByTestId("weapon-sync"));
    await waitFor(() => {
      const status = screen.getByTestId("unity-sync-status");
      expect(status.textContent).toMatch(/Unity: Queued/i);
    });
  });

  it("labels per-weapon Unity sync distinctly from Connections", async () => {
    weaponsState = [
      baseWeapon({ unitySync: { state: "disconnected" } }),
      baseWeapon({
        id: rightId,
        displayName: "Right Applied",
        role: "right_pistol",
        unitySync: { state: "applied", assetGuid: "g", assetPath: "Assets/x.asset" },
      }),
      baseWeapon({
        id: "33333333-3333-4333-8333-333333333333",
        displayName: "Failed Left",
        role: "left_pistol",
        unitySync: { state: "failed" },
      }),
    ];
    renderWeapons();
    const page = await waitFor(() => screen.getByTestId("weapons-page"));
    const labels = await waitFor(() => within(page).getAllByTestId("weapon-unity-sync-label"));
    const texts = labels.map((el) => el.textContent);
    expect(texts).toContain("Unity: Not synced");
    expect(texts).toContain("Unity: Applied");
    expect(texts).toContain("Unity: Failed");
    for (const el of labels) {
      expect(el.getAttribute("aria-label")).toMatch(/separate from the overall Studio connection/i);
      expect(el.getAttribute("title")).toMatch(/weapon definition/i);
    }
    expect(within(page).queryByText(/^disconnected$/i)).not.toBeInTheDocument();
    expect(within(page).queryByText(/^Connected$/i)).not.toBeInTheDocument();
  });

  it("Remove opens guided panel with mapping actions beside the button", async () => {
    weaponsState = [
      baseWeapon({
        unitySync: {
          state: "applied",
          assetGuid: "guid-1",
          assetPath: "Assets/HertzStudio/Weapons/Definitions/x.asset",
        },
      }),
    ];
    renderWeapons();
    await waitFor(() => expect(screen.getByTestId("weapon-row-left_pistol")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("weapon-row-left_pistol"));
    fireEvent.click(screen.getByTestId("weapon-remove"));
    await waitFor(() => expect(screen.getByTestId("weapon-remove-panel")).toBeInTheDocument());
    expect(screen.getByTestId("weapon-remove-scope")).toHaveTextContent(/Asset Library model/i);
    expect(screen.getByTestId("weapon-remove-dep-unity_mapping")).toBeInTheDocument();
    expect(screen.getByTestId("weapon-remove-retain-unity")).toBeInTheDocument();
    expect(screen.getByTestId("weapon-remove-delete-unity")).toBeInTheDocument();
    expect(screen.queryByTestId("weapon-remove-cancel-queued")).not.toBeInTheDocument();
  });

  it("queued Unity sync offers cancel-queued-and-remove beside Remove", async () => {
    weaponsState = [
      baseWeapon({
        unitySync: { state: "queued", lastRequestId: "req-q" },
      }),
    ];
    renderWeapons();
    await waitFor(() => expect(screen.getByTestId("weapon-row-left_pistol")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("weapon-row-left_pistol"));
    fireEvent.click(screen.getByTestId("weapon-remove"));
    await waitFor(() => expect(screen.getByTestId("weapon-remove-cancel-queued")).toBeInTheDocument());
    expect(screen.queryByTestId("weapon-remove-delete-unity")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("weapon-remove-cancel-queued"));
    await waitFor(() =>
      expect(screen.getByTestId("weapons-message")).toHaveTextContent(/Catalog entry removed|preserved/i),
    );
  });

  it("truthful not-synced state and optional sound note", async () => {
    weaponsState = [baseWeapon({ unitySync: { state: "disconnected" } })];
    renderWeapons();
    const page = await waitFor(() => screen.getByTestId("weapons-page"));
    await waitFor(() => expect(within(page).getByTestId("weapon-row-left_pistol")).toBeInTheDocument());
    fireEvent.click(within(page).getByTestId("weapon-row-left_pistol"));
    await waitFor(() =>
      expect(within(page).getByTestId("unity-sync-status")).toHaveTextContent(/Unity: Not synced/i),
    );
    expect(within(page).getByTestId("weapon-unity-sync-label")).toHaveTextContent("Unity: Not synced");
    expect(within(page).getByTestId("placeholder-content-note")).toHaveTextContent(
      /silently|Sound section/i,
    );
  });

  it("enables Confirm and blocks Sync for legacy missing-metadata wrappers", async () => {
    const wrapPath = `Assets/HertzStudio/Weapons/Wrappers/${leftId}/HERTZ_Pistol_Optimized_Rigged_Anchored.prefab`;
    expect(
      wrapperNeedsStudioConfirm({
        path: wrapPath,
        provisional: true,
        confirmed: false,
        needsConfirmation: true,
        recoveryReason: "missing_metadata",
      }),
    ).toBe(true);

    weaponsState = [
      baseWeapon({
        runtimeModelPrefabPath: wrapPath,
        wrapperAnchorMeta: {
          path: wrapPath,
          provisional: true,
          confirmed: false,
          needsConfirmation: true,
          recoveryReason: "missing_metadata",
        },
        runtimeReadiness: {
          modelImported: true,
          definitionSynced: false,
          anchorsValid: false,
          runtimeDeployApplied: false,
          runtimePlayable: false,
        },
      }),
    ];
    renderWeapons();
    await waitFor(() => expect(screen.getByTestId("weapon-row-left_pistol")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("weapon-row-left_pistol"));
    await waitFor(() => expect(screen.getByTestId("weapon-wrapper-confirm-required")).toBeInTheDocument());
    expect(screen.getByTestId("weapon-wrapper-confirm-required")).toHaveTextContent(/Confirmation required/i);
    expect(screen.getByTestId("weapon-confirm-anchor-wrapper")).not.toBeDisabled();
    expect(screen.getByTestId("weapon-sync")).toBeDisabled();

    api.mockImplementation(async (path, opts = {}) => {
      if (path === "/api/weapons") {
        return { loadout: loadoutState, weapons: weaponsState };
      }
      if (path === "/api/unity/scenes") return { scenes: [] };
      if (path === "/api/sound") return { slots: [] };
      if (String(path).startsWith("/api/weapons/models/")) return { models: [] };
      if (opts.method === "POST" && String(path).includes("/confirm-anchor-wrapper")) {
        const raw = opts.body;
        const body =
          typeof raw === "string" ? JSON.parse(raw || "{}") : raw && typeof raw === "object" ? raw : {};
        expect(body.wrapperPrefabPath == null || body.wrapperPrefabPath === "").toBe(true);
        const confirmed = {
          ...weaponsState[0],
          version: 2,
          runtimeModelPrefabPath: wrapPath,
          wrapperAnchorMeta: {
            path: wrapPath,
            provisional: false,
            confirmed: true,
            needsConfirmation: false,
            recoveryReason: null,
          },
        };
        weaponsState = [confirmed];
        return { ok: true, wrapperPrefabPath: wrapPath, weapon: confirmed, note: "Anchors confirmed." };
      }
      return {};
    });

    fireEvent.click(screen.getByTestId("weapon-confirm-anchor-wrapper"));
    await waitFor(() => expect(screen.getByTestId("weapons-message")).toHaveTextContent(/confirmed/i));
    await waitFor(() => expect(screen.queryByTestId("weapon-wrapper-confirm-required")).not.toBeInTheDocument());
    expect(screen.getByTestId("weapon-sync")).not.toBeDisabled();
    expect(screen.getByTestId("weapon-runtime-prefab-path")).toHaveTextContent(wrapPath);
  });
});
