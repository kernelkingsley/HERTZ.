import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import {
  listMilestones,
  statusBadgeVariant,
  summarizeMilestoneProgress,
} from "../lib/milestoneStatus.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function Milestones() {
  const milestones = listMilestones();
  const summary = summarizeMilestoneProgress(milestones);
  const [detailId, setDetailId] = useState("");
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    if (!detailId) {
      setDetail(null);
      setDetailError("");
      return undefined;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError("");
    api(`/api/milestones/${detailId}/details`)
      .then((payload) => {
        if (!cancelled) setDetail(payload);
      })
      .catch((e) => {
        if (!cancelled) setDetailError(String(e.message || e));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [detailId]);

  return (
    <div className="page-enter">
      <div className="page-head">
        <div>
          <div className="eyebrow mb-3">Work plan</div>
          <h1>W01–W14 milestones</h1>
          <p>
            Shared status source of truth. Completed requires tasks, verification, Codex review, and Kingsley
            testing — not implementation alone. Click a milestone for an implementation breakdown.
          </p>
        </div>
        <Badge variant="outline" className="rounded-full border-white/15" data-testid="milestone-percent">
          {summary.percentComplete}% complete ({summary.completed}/{summary.total})
        </Badge>
      </div>

      <div className="mb-6 flex flex-wrap gap-2" data-testid="milestone-summary-totals">
        {Object.entries(summary.counts).map(([label, count]) => (
          <div key={label} className="glass-pill text-xs">
            {label}: {count}
          </div>
        ))}
      </div>

      <div className="grid gap-3">
        {milestones.map((row) => (
          <Card
            key={row.id}
            data-testid={`milestone-row-${row.id}`}
            className="cursor-pointer transition hover:border-primary/40"
            onClick={() => setDetailId(row.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setDetailId(row.id);
              }
            }}
            role="button"
            tabIndex={0}
          >
            <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
              <div>
                <CardTitle className="text-base tracking-tight">
                  {row.id} — {row.title}
                </CardTitle>
                <CardDescription>Click for files, features, assets, and proof results.</CardDescription>
              </div>
              <Badge variant={statusBadgeVariant(row.status)} className="rounded-full" data-testid={`milestone-status-${row.id}`}>
                {row.status}
              </Badge>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              tasks {row.gates.tasksComplete ? "✓" : "·"} · auto {row.gates.automatedVerification ? "✓" : "·"} ·
              manual {row.gates.manualVerification ? "✓" : "·"} · Codex {row.gates.codexReview ? "✓" : "·"} ·
              Kingsley {row.gates.kingsleyTesting ? "✓" : "·"}
              {row.id === "W03" ? (
                <span className="ml-2">
                  <Link
                    className="text-[var(--glow)] underline-offset-2 hover:underline"
                    to="/level-editor"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Open Level editor
                  </Link>
                </span>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>

      {detailId ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
          data-testid="milestone-detail-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="milestone-detail-title"
          onClick={() => setDetailId("")}
        >
          <div
            className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-white/10 bg-[var(--card)] p-5 shadow-xl"
            data-testid="milestone-detail-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 id="milestone-detail-title" className="text-lg font-semibold tracking-tight">
                  {detailId}
                  {detail?.title ? ` — ${detail.title}` : ""}
                </h2>
                {detail?.status ? (
                  <Badge variant={statusBadgeVariant(detail.status)} className="mt-2 rounded-full">
                    {detail.status}
                  </Badge>
                ) : null}
              </div>
              <Button type="button" variant="outline" size="sm" data-testid="milestone-detail-close" onClick={() => setDetailId("")}>
                Close
              </Button>
            </div>

            {detailLoading ? <p className="text-sm text-muted-foreground">Loading detail…</p> : null}
            {detailError ? <p className="error text-sm">{detailError}</p> : null}

            {detail && !detailLoading ? (
              <div className="space-y-4 text-sm" data-testid="milestone-detail-body">
                <p className="text-muted-foreground">{detail.statusNote}</p>
                {detail.placeholder ? (
                  <p className="rounded-xl border border-white/10 px-3 py-2 text-xs text-muted-foreground">
                    Placeholder — curated breakdown lands when this milestone is delivered. W03–W05 have full detail.
                  </p>
                ) : null}

                <Section title="Features" testId="milestone-detail-features" items={detail.features} />
                <Section title="Files" testId="milestone-detail-files" items={detail.files} mono />
                <Section title="Assets" testId="milestone-detail-assets" items={detail.assets} />
                <Section
                  title="Behavioral changes"
                  testId="milestone-detail-behavior"
                  items={detail.behavioralChanges}
                />

                <div data-testid="milestone-detail-proofs">
                  <h3 className="mb-2 text-sm font-medium">Proof results</h3>
                  {detail.proofs?.length ? (
                    <ul className="space-y-1 text-xs">
                      {detail.proofs.map((p) => (
                        <li
                          key={p.file}
                          className="rounded-lg border border-white/10 px-2 py-1.5"
                          data-testid={`milestone-proof-${p.file}`}
                        >
                          <span className="font-mono">{p.file}</span>
                          {": "}
                          {!p.present
                            ? "missing"
                            : p.ok
                              ? `pass ${p.passed}/${p.total}`
                              : `fail ${p.passed}/${p.total}`}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted-foreground">No proof files listed.</p>
                  )}
                  {detail.proofSummary ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Summary: {detail.proofSummary.ok}/{detail.proofSummary.total} artifacts ok (
                      {detail.proofSummary.present} present)
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Section({ title, items, testId, mono }) {
  if (!items?.length) {
    return (
      <div data-testid={testId}>
        <h3 className="mb-2 text-sm font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground">None listed.</p>
      </div>
    );
  }
  return (
    <div data-testid={testId}>
      <h3 className="mb-2 text-sm font-medium">{title}</h3>
      <ul className="list-inside list-disc space-y-1 text-xs text-muted-foreground">
        {items.map((item) => (
          <li key={item} className={mono ? "font-mono" : undefined}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
