import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import WeaponRemovePanel from "./WeaponRemovePanel.jsx";

describe("WeaponRemovePanel", () => {
  afterEach(() => cleanup());

  it("shows only cancel-queued when that action is available", () => {
    render(
      <WeaponRemovePanel
        open
        onClose={() => {}}
        onRefresh={() => {}}
        onAction={() => {}}
        inspection={{
          dependencies: [{ kind: "sync_job", detail: "pending_unity", status: "pending_unity" }],
          actions: { cancelQueuedSyncAndRemove: true },
          nextAction: "Cancel queued sync and remove",
        }}
      />,
    );
    expect(screen.getByTestId("weapon-remove-cancel-queued")).toBeInTheDocument();
    expect(screen.queryByTestId("weapon-remove-delete-unity")).not.toBeInTheDocument();
    expect(screen.queryByTestId("weapon-remove-retain-unity")).not.toBeInTheDocument();
  });

  it("shows retain and delete-unity for applied mapping only", () => {
    render(
      <WeaponRemovePanel
        open
        onClose={() => {}}
        onRefresh={() => {}}
        onAction={() => {}}
        inspection={{
          dependencies: [{ kind: "unity_mapping", detail: "mapped", assetPath: "Assets/x.asset" }],
          actions: { deleteUnityAndRemove: true, retainUnityAndRemove: true },
          nextAction: "Delete or retain",
        }}
      />,
    );
    expect(screen.getByTestId("weapon-remove-delete-unity")).toBeInTheDocument();
    expect(screen.getByTestId("weapon-remove-retain-unity")).toBeInTheDocument();
    expect(screen.queryByTestId("weapon-remove-cancel-queued")).not.toBeInTheDocument();
  });

  it("applying state shows refresh and refuses cancel control", () => {
    render(
      <WeaponRemovePanel
        open
        onClose={() => {}}
        onRefresh={() => {}}
        onAction={() => {}}
        inspection={{
          dependencies: [{ kind: "sync_job", detail: "applying", status: "applying" }],
          actions: { refreshStatus: true, cancelQueuedSyncAndRemove: false },
          nextAction: "Refresh status",
        }}
      />,
    );
    expect(screen.getByTestId("weapon-remove-refresh")).toBeInTheDocument();
    expect(screen.queryByTestId("weapon-remove-cancel-queued")).not.toBeInTheDocument();
    expect(screen.getByTestId("weapon-remove-applying-note")).toBeInTheDocument();
  });

  it("explains catalog-only scope", () => {
    render(
      <WeaponRemovePanel
        open
        onClose={() => {}}
        onRefresh={() => {}}
        onAction={() => {}}
        inspection={{ dependencies: [], actions: { removeNow: true } }}
      />,
    );
    expect(screen.getByTestId("weapon-remove-scope")).toHaveTextContent(/does not delete/i);
    expect(screen.getByTestId("weapon-remove-confirm")).toBeInTheDocument();
  });

  it("unassign button passes matching sides", () => {
    const onAction = vi.fn();
    render(
      <WeaponRemovePanel
        open
        onClose={() => {}}
        onRefresh={() => {}}
        onAction={onAction}
        inspection={{
          dependencies: [{ kind: "loadout_left", detail: "left" }],
          actions: { unassignLoadoutLeft: true, unassignLoadoutRight: false },
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("weapon-remove-unassign"));
    expect(onAction).toHaveBeenCalledWith("unassign_and_remove", { sides: ["left"] });
  });

  it("shows conflict outcome and retry/retain actions", () => {
    render(
      <WeaponRemovePanel
        open
        onClose={() => {}}
        onRefresh={() => {}}
        onAction={() => {}}
        inspection={{
          status: "conflict",
          error: "Unity conflict on delete",
          nextAction: "Retry with a new requestId",
          modelAssetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          modelPreserved: true,
          dependencies: [],
          actions: {},
        }}
      />,
    );
    expect(screen.getByTestId("weapon-remove-outcome")).toHaveTextContent(/Conflict/i);
    expect(screen.getByTestId("weapon-remove-outcome")).toHaveTextContent(/model preserved/i);
    expect(screen.getByTestId("weapon-remove-delete-unity")).toHaveTextContent(/Retry/i);
    expect(screen.getByTestId("weapon-remove-retain-unity")).toBeInTheDocument();
  });
});
