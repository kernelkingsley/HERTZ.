# Deploy notes (W01 pending / W14 implements)

| Item | Value |
| --- | --- |
| Production hostname | `https://studio.hertz.software` |
| Root domain | `hertz.software` (reserved for game site) |
| Registrar | Name.com |
| Cloud host | **Not selected** |
| Status | **Pending** — hosting setup deferred 20 October 2026 |

## W01 prepares

- Production-oriented web build (`npm run build -w web`)
- API that can serve `web/dist` and durable draft/queue storage
- Deploy UI entry listing checklist and pending status
- Secrets via environment / local data (not browser storage)

## Still required before live deploy (W14)

1. Select and verify a host / student benefit and credit limits.
2. Accept host + Name.com credentials into local OS credential store only.
3. Show concrete resource/DNS/cost plan with enforced vs estimated spend distinction.
4. Publish Studio artifacts only; bind DNS; verify HTTPS, sign-in, API, storage, connector from a second device.
5. Rollback path without deleting unrelated DNS records.

Local checks do **not** establish remote hosted operation.
