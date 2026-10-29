# HERTZ Studio (W01 foundation)

Independently deployable web + API + Unity connector for authoring HERTZ. Source lives in this repo under `Tools/HertzStudio/`. Do not publish the Unity project, `Library/`, or `node_modules` as static site content.

**Production URL (pending host):** https://studio.hertz.software  
**Domain / registrar:** hertz.software at Name.com  
**Hosting/DNS setup:** deferred by Kingsley (20 October 2026). Develop and verify locally.

## Layout

| Path | Role |
| --- | --- |
| `web/` | Vite + React private Studio UI (dark/lime shell) |
| `api/` | Express API, owner auth, durable file-backed drafts/queue |
| `connector/` | Outbound poller on the Unity PC |
| `docs/` | MCP reuse + deploy notes |
| `../Assets/Editor/HertzStudio/` | Loopback Editor bridge (excluded from player builds) |

## Local startup

```powershell
cd Tools/HertzStudio
npm install
npm run dev:api
# other terminal
npm run dev:web
```

Owner password: set `HERTZ_OWNER_PASSWORD` (min 10 chars) before first start, or complete the one-time local setup screen. There is no hardcoded default. Hosted/production mode refuses to start without `HERTZ_OWNER_PASSWORD`.

Pair Unity:

1. Sign in → Connections → Pair Unity connector (copy code).
2. `npm run pair -w connector -- <CODE>`
3. With Unity open on HertzStudioTest (bridge on `127.0.0.1:8791`): `npm run start -w connector`

## Proof / measure

```powershell
npm run build -w web
npm run measure:dashboard
# API running:
npm run proof:drafts
```

## Security boundaries

- Browser never requires localhost Unity access for draft browsing/saving.
- Editor bridge binds `127.0.0.1` only.
- Connector tokens stay on the Unity machine under `data/` (gitignored).
- No provider secrets in frontend bundles or Git.
