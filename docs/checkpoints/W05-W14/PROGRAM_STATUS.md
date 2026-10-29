# W05–W14 correction / vertical-completion program

- Updated (UTC): **2026-10-26T14:40:00Z**
- Owner: Grok in Cursor (handoff → Codex)
- Branch/HEAD: `main` / `7374e57`
- SampleScene: do not modify; prior known SHA256 `9FB1EFEA…F4D9`
- API/bridge: down during session; Unity Editor had project open (batchmode locked)

## Checkpoints

| CP | Milestone | Implementation | Live Unity evidence | Gate |
|----|-----------|----------------|---------------------|------|
| A | W05 proof harden | Done (schema 3 + fingerprint + freshness fail-closed) | Pending — Editor open blocks batchmode; menus after domain reload | Ready for Kingsley testing (unchanged) |
| B | W06 capture lifecycle | Done (`CompleteAndStage`, dynamic targets, runtime proof runner) | Pending — need domain reload + menu | In progress |
| C | W07 sound ack | Done (exact hash / stale / missing / idempotent) | Live playback still pending | In progress |
| D | W08 undo/materials | Partial — operation-scoped undo journal + HDRI prior snapshot; live floor/wall/Terrain/HDRI proof pending | Pending | In progress |
| E | W09 animation | Prior vertical contracts; runtime bind/Play Mode still incomplete | Pending | In progress |
| F | W10 perf capture | Partial — Editor sample loop replaces hardcoded 60Hz/1-sample; findings links still thin | Pending | In progress |
| G | W11 snapshots | Prior capture contracts; atomic restore still incomplete | Pending | In progress |
| H | W12 encounters | Prior validate/runtime stubs; typed asset + scheduler incomplete | Pending | In progress |
| I | W13 integration | W13 rejects presence-only; cross-module live workflow not run | Pending | In progress |
| J | W14 deploy prep | `provider_not_selected` for arbitrary providers; preview-only honesty | N/A | In progress |

## Do not claim

- Milestone Completed
- `codexReview:true` for corrected milestones
- Live Unity apply/playback/restore without executed proof
- Quest / public deploy / DNS / Mixamo Adobe automation
