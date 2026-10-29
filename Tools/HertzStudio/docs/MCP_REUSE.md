# Unity MCP reuse notes (W01)

Checked 20 October 2026 against this HERTZ project.

## What exists

- Cursor MCP namespace `user-unity-mcp` (relay via `relay_win.exe`).
- Installed package `com.unity.ai.assistant` 2.20.0-pre.2 with Editor MCP tools.
- Live read-only check in W01: `Unity_ManageScene` `GetActive` returned `SampleScene` successfully while Unity + relay processes were running.

## Suitable free operations (reuse on the Unity machine)

- Scene hierarchy / active scene queries (`Unity_ManageScene`).
- GameObject find / component inspection (`Unity_ManageGameObject` read paths).
- Asset find/list (`Unity_ManageAsset` read paths).
- Console / project metadata tools for diagnostics.

## Gaps for hosted Studio (implemented by Hertz bridge instead)

- Versioned cloud drafts and durable apply queue with requestId dedupe.
- Bound `baseUnityRevision` + draft version conflict checks.
- Authenticated outbound connector (browser never talks to Editor/MCP).
- Explicit apply / undo / save acknowledgments with distinct status labels.
- Loopback-only HTTP bridge (`http://127.0.0.1:8791`, configurable via `bridgePort` in bridge-token.json) used by the connector.

## Rules

- Do not expose MCP named pipes, IPC, or unrestricted tools on the public internet.
- Do not install a second custom MCP server for W01.
- Preserve the user's global Cursor MCP configuration.
- Hosted browsing and draft saves must work with Unity offline; apply waits for the connector.

## Entitlement / cost

- No paid MCP entitlement was required for the read-only GetActive check performed in W01.
- If MCP becomes unavailable or requires payment, the Editor bridge alone remains the apply path.
