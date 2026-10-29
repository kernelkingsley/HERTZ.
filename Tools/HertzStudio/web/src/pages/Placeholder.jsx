import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { getMilestoneStatus, statusBadgeVariant } from "../lib/milestoneStatus.js";

export default function Placeholder({ title, task }) {
  const status = getMilestoneStatus(task);
  return (
    <div className="page-enter">
      <div className="page-head">
        <div>
          <div className="eyebrow mb-3" data-testid={`placeholder-status-${task}`}>
            {status}
          </div>
          <h1>{title}</h1>
          <p>
            Reserved in the HERTZ Studio shell. Milestone <strong>{task}</strong> is currently{" "}
            <strong>{status}</strong> (shared W01–W14 status source).
          </p>
        </div>
        <Badge variant={statusBadgeVariant(status)} className="rounded-full border-white/15">
          {task}: {status}
        </Badge>
      </div>
      <Card>
        <CardContent className="pt-6">
          <p className="muted">
            No 3D engine is loaded on this page. Dashboard and shell stay free of the editor bundle.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
