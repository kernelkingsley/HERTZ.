import { Button } from "@/components/ui/button";

/**
 * Guided weapon catalog removal — shown beside Remove.
 * Does not delete Asset Library models, unrelated sounds, or scene objects.
 */
export default function WeaponRemovePanel({
  open,
  inspection,
  busy = false,
  onClose,
  onRefresh,
  onAction,
}) {
  if (!open) return null;

  const deps = inspection?.dependencies || [];
  const actions = inspection?.actions || {};
  const nextAction = inspection?.nextAction || "";
  const status = inspection?.status || null;
  const sides = Array.isArray(inspection?.sides) ? inspection.sides : [];
  const outcomeLabel =
    status === "queued"
      ? "Queued — waiting for Unity"
      : status === "applying" || status === "waiting_unity"
        ? "Applying / waiting for Unity acknowledgement"
        : status === "failed"
          ? "Failed"
          : status === "conflict"
            ? "Conflict"
            : status === "completed" || inspection?.deleted
              ? "Completed"
              : status === "blocked"
                ? "Blocked by dependencies"
                : null;

  const destructiveLocked = Boolean(busy) || status === "queued" || status === "waiting_unity" || status === "applying";

  return (
    <div
      className="mt-3 space-y-3 rounded-xl border border-amber-500/40 bg-black/30 p-3 text-xs"
      data-testid="weapon-remove-panel"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-foreground">Confirm weapon removal</p>
          <p className="mt-1 text-muted-foreground" data-testid="weapon-remove-scope">
            This removes the <strong>weapon catalog definition</strong> only. It does{" "}
            <strong>not</strong> delete the linked Asset Library model, unrelated sound assets, or
            scene objects unless you explicitly place/delete those elsewhere.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="weapon-remove-cancel"
          disabled={busy}
          onClick={onClose}
        >
          Close
        </Button>
      </div>

      {outcomeLabel ? (
        <p
          className="rounded-lg border border-white/10 px-2 py-1.5 text-[11px]"
          data-testid="weapon-remove-outcome"
          data-status={status || (inspection?.deleted ? "completed" : "")}
        >
          Outcome: <strong>{outcomeLabel}</strong>
          {inspection?.error ? ` — ${inspection.error}` : ""}
          {inspection?.modelPreserved === false
            ? " (model missing — unexpected)"
            : inspection?.modelAssetId
              ? " · Asset Library model preserved"
              : ""}
        </p>
      ) : null}

      {sides.length ? (
        <p className="text-[11px]" data-testid="weapon-remove-sides">
          Loadout sides that will be unassigned: <strong>{sides.join(", ")}</strong>
        </p>
      ) : actions.unassignLoadoutLeft || actions.unassignLoadoutRight ? (
        <p className="text-[11px]" data-testid="weapon-remove-sides-pending">
          Unassign will clear:{" "}
          <strong>
            {[
              actions.unassignLoadoutLeft ? "left" : null,
              actions.unassignLoadoutRight ? "right" : null,
            ]
              .filter(Boolean)
              .join(", ")}
          </strong>
        </p>
      ) : null}

      {deps.length ? (
        <div data-testid="weapon-remove-deps">
          <p className="mb-1 font-medium text-foreground">Blocking dependencies</p>
          <ul className="list-disc space-y-1 pl-4" data-testid="weapon-remove-deps-list">
            {deps.map((d, i) => (
              <li key={`${d.kind}-${d.requestId || i}`} data-testid={`weapon-remove-dep-${d.kind}`}>
                <span className="font-medium">{d.kind}</span>: {d.detail}
                {d.status ? ` [${d.status}]` : ""}
                {d.assetPath ? ` (${d.assetPath})` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p data-testid="weapon-remove-no-deps">No blockers — catalog entry can be removed now.</p>
      )}

      {nextAction ? (
        <p className="rounded-lg border border-white/10 px-2 py-1.5 text-[11px]" data-testid="weapon-remove-next">
          Next: {nextAction}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2" data-testid="weapon-remove-actions">
        {actions.unassignLoadoutLeft || actions.unassignLoadoutRight ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={destructiveLocked}
            data-testid="weapon-remove-unassign"
            onClick={() =>
              onAction("unassign_and_remove", {
                sides: [
                  ...(actions.unassignLoadoutLeft ? ["left"] : []),
                  ...(actions.unassignLoadoutRight ? ["right"] : []),
                ],
              })
            }
          >
            Unassign and remove
          </Button>
        ) : null}

        {actions.cancelQueuedSyncAndRemove ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={destructiveLocked}
            data-testid="weapon-remove-cancel-queued"
            onClick={() => onAction("cancel_queued_and_remove")}
          >
            Cancel queued sync and remove
          </Button>
        ) : null}

        {actions.refreshStatus || status === "queued" || status === "failed" || status === "conflict" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            data-testid="weapon-remove-refresh"
            onClick={onRefresh}
          >
            Refresh status
          </Button>
        ) : null}

        {actions.deleteUnityAndRemove || status === "failed" || status === "conflict" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={destructiveLocked && status !== "failed" && status !== "conflict"}
            data-testid="weapon-remove-delete-unity"
            onClick={() => onAction("delete_unity_and_remove")}
          >
            {status === "failed" || status === "conflict"
              ? "Retry Delete Unity definition and remove"
              : "Delete Unity definition and remove"}
          </Button>
        ) : null}

        {actions.retainUnityAndRemove || status === "failed" || status === "conflict" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={destructiveLocked && status !== "failed" && status !== "conflict"}
            data-testid="weapon-remove-retain-unity"
            onClick={() => {
              if (
                !window.confirm(
                  "Keep the Unity HertzWeaponDefinition asset and remove only the Studio catalog entry?",
                )
              ) {
                return;
              }
              onAction("retain_unity_and_remove");
            }}
          >
            Keep Unity definition and remove catalog entry
          </Button>
        ) : null}

        {actions.removeNow ? (
          <Button
            type="button"
            size="sm"
            disabled={destructiveLocked}
            data-testid="weapon-remove-confirm"
            onClick={() => onAction("remove_now")}
          >
            Confirm remove catalog entry
          </Button>
        ) : null}
      </div>

      {(actions.refreshStatus && !actions.cancelQueuedSyncAndRemove) || status === "queued" ? (
        <p className="text-[11px] text-[var(--glow)]" data-testid="weapon-remove-applying-note">
          An applying or uncertain Unity job cannot be cancelled here. Reconnect the bridge, then Refresh
          status. Deletion will not be reported until the Unity outcome is known. Overlapping destructive
          actions stay disabled while a removal is in flight.
        </p>
      ) : null}
    </div>
  );
}
