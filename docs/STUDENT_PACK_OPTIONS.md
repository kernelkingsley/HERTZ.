# GitHub Student Pack options for HERTZ Studio

Checked against GitHub/provider documentation on **20 October 2026**. These are recommendations for Kingsley to select, not instructions to install every service or activate paid resources. Eligibility, redemption, actual account balances, expiry, and allowed usage must be verified in the redeemed account. No cloud offer activation or credit balance has been verified by Codex.

## Confirmed project context

**Hosting setup is deferred at Kingsley's request on 20 October 2026.** Azure student verification still fails after receiving the school-email code and retrying Chrome Incognito. No subscription eligibility is confirmed. Continue cloud-ready Studio development with local checks; revisit provider selection, provisioning, deployment, and DNS later.

- Kingsley has the GitHub Student Developer Pack and registered **hertz.software through Name.com**, using its offer. The domain is owned; a cloud host has not yet been selected.
- HERTZ Studio needs a hosted private frontend/API, persistent drafts and a Unity command queue, private model/texture/audio storage, and the existing Unity computer's outbound connector.
- Add a local Studio deployment page where Kingsley can connect the selected cloud provider and Name.com, review a release plan, and deploy to the domain. See W14 in [WEB_STUDIO_TASKS.md](WEB_STUDIO_TASKS.md).
- Confirmed private app address: **https://studio.hertz.software**, selected by Kingsley on 20 October 2026. Use this production target and leave the root domain available for the game website. This selects the hostname; cloud hosting/provider choices remain open.

## Hosting recommendation for approval

**Namecheap clarification:** its Student Pack offer includes a `.me` domain and one SSL certificate free for one year; it does not include free hosting. Namecheap sells hosting separately and currently advertises a 30-day shared-hosting trial, which is temporary rather than an ongoing student benefit. No purchase, trial, or domain transfer is selected. Kingsley already owns the required domain through Name.com. [Student offer](https://nc.me/landing/github), [hosting plans](https://www.namecheap.com/hosting/).

**Heroku is a practical first candidate if its student credit is available in Kingsley's account.** The provider advertises **$13/month for 24 months**, applicable to its own products, excluding third-party add-ons. Redemption requires age 18+ and a valid payment card. Unused monthly credits do not roll over, and overages/expired benefits become chargeable. Do not provision anything merely because a Student Pack account exists. [Heroku student offer](https://www.heroku.com/github-students/).

Current list prices put **one Basic app at $7/month plus Essential-0 Postgres at $5/month = $12/month**, within that advertised monthly credit before additional resources. Basic is always on; Eco sleeps after inactivity. This is a small starting deployment to benchmark, not a performance guarantee. Do not add a separately billed worker/Redis/staging app automatically. A database-backed command queue can avoid a second managed queue initially. Recheck prices and activated benefits before creating resources. [Heroku pricing](https://www.heroku.com/pricing/).

That estimate is not a provider-enforced spending cap: other account usage and benefit expiry can create charges. If Kingsley requires a hard zero-spend guarantee, choose a service/account configuration with an enforceable stop rather than calling this credit-backed estimate guaranteed free. The Deploy page must show that distinction.

The cost estimate **does not include private asset storage or domain renewal**. Model packs, audio, textures, and snapshot backups need durable blob storage with separately verified allowances. Heroku's container filesystem is ephemeral; it must not hold the only copy of uploads or snapshots. Select storage once expected asset volume and account benefits are known. Do not put the Unity repository or assets in the static web build. [Heroku dynos/filesystem](https://devcenter.heroku.com/articles/dynos#ephemeral-filesystem).

Azure is another candidate for experiments: its student offer advertises **$100 credit usable within 12 months**, with service-specific free allowances. Treat credits, always-free quotas, and education-related terms as separate constraints; confirm intended project use and subscription terms before choosing it for production. [Azure for Students](https://azure.microsoft.com/en-us/free/students/).

Appwrite includes hosting/backend components, but its current Education plan lasts **six months** and explicitly excludes non-educational/commercial use. It is not the default for a potentially commercial HERTZ deployment. [Appwrite Education FAQ](https://appwrite.io/education).

GitHub Pages can host a static frontend/landing page, but it is a static hosting service, so it would still need a separate backend for private drafts, deployment secrets, and Unity commands. [GitHub Pages documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).

## Useful companion tools — awaiting approval

| Tool | Benefit checked | Specific use and recommendation |
| --- | --- | --- |
| **Clerk** | Student access to Pro-equivalent features while eligible; SMS excluded, one workspace. [Provider offer](https://clerk.com/github-student-developer-pack). | Strong candidate for Studio owner sign-in and MFA. Still enforce project authorization on the API; do not turn this into a public signup product. |
| **Sentry** | Pack lists a one-year renewable student allocation with Team features and on-demand disabled. [Current Pack listing](https://education.github.com/pack#sentry). | Strong candidate for web/API errors and release diagnostics. Scrub tokens, uploaded content, and personal data. Do not enable session replay or game telemetry automatically. Confirm actual quotas/renewal. |
| **Doppler** | Free Team subscription for eligible students. [Provider offer](https://www.doppler.com/secretsops-for-students). | Useful for environment secrets shared between deployment and runtime. Optional: native provider secrets plus the local OS credential store can keep the initial stack smaller. |
| **BrowserStack** | Provider advertises a one-year student subscription; exact activated product scope must be checked. [Provider offer](https://www.browserstack.com/github-students). | Test drag/drop, uploads, sign-in, and layout across browsers/devices. This does not replace Unity or Quest hardware testing. |
| **GitHub Pro + Codespaces** | Verified student access includes Codespaces' Pro-level monthly allowance. [Student benefits](https://docs.github.com/en/education/about-github-education/github-education-for-students/about-github-education-for-students), [billing/quotas](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces). | Useful for Studio web development away from the Unity computer and reproducible development containers. Stop idle instances and set spending limits. It is not the persistent production host or a Quest testing environment. |
| **GitHub Actions** | Available through GitHub; usage depends on plan/repo/runner. This is a workflow option, not an unlimited student cloud grant. [Included usage](https://docs.github.com/en/billing/reference/product-usage-included). | Build/test Studio and deploy selected releases. Prefer supported short-lived cloud credentials through OIDC; otherwise use protected deployment secrets. [OIDC documentation](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-cloud-providers). |
| **Datadog** | Pack lists Pro monitoring for 10 servers for two years. [Current Pack listing](https://education.github.com/pack#datadog). | Consider later if infrastructure grows. Keep separate from the in-game Quest performance inspector; avoid installing several overlapping monitoring systems now. |

Recommended first choices to approve: **one hosting provider**, then **Clerk + Sentry**. BrowserStack is useful during verification; Doppler/Codespaces/Datadog can be added when their benefit exceeds their setup cost. No optional tool is a required Studio dependency until selected.

## Other offers and limits worth knowing

- **GitHub Copilot Student** can assist implementation; the current Pack describes a limited student chat/agent allowance and code completions. It does not supply Codex/Grok credits. **MongoDB Atlas** credits are another database option; avoid introducing a second database solely to consume an offer. [Pack catalog](https://education.github.com/pack).
- **1Password** is another way to keep personal tokens/passwords: GitHub's listing and provider wording are inconsistent about duration, so confirm the redeemed expiry rather than promising a fixed term. It is an alternative to storing personal secrets casually, not a required Studio SDK. [Provider offer](https://1password.com/developers/students), [Pack catalog](https://education.github.com/pack).
- DigitalOcean's old student-credit promotion is **not present in the current Pack catalog**; do not budget around older tutorials. [Current catalog](https://education.github.com/pack).
- Track each redeemed offer's start/end, quota, allowed use, renewal behavior, and export/downgrade path. Keep auto-upgrades/paid add-ons off. A free benefit expiring must not silently convert the project into an open-ended bill.

## Deployment credentials and Name.com

Name.com manages domain/DNS access; it is not interchangeable with a hosting token. Implement against the currently supported account/API, using the [Name.com CORE documentation](https://docs.name.com/), not an assumed legacy endpoint. Verify whether this account's API supports the required DNS operations. If unavailable, show the exact DNS records for manual entry; deployment must not falsely claim DNS automation succeeded.

The initial local Deploy page accepts credentials into a trusted local backend, performs a read-only connection test, and retains them only in the OS credential store or a selected secret manager. Never use localStorage, frontend environment variables, source files, logs, exported backups, or public deployment artifacts for secret persistence. Once deployed, the hosted app does not need a copy of broad local deployment credentials. Runtime provider keys go in the host's secret configuration. Prefer OAuth/short-lived credentials where the chosen provider supports them; do not claim all providers offer per-domain/per-app scopes. [Heroku OAuth scopes](https://devcenter.heroku.com/articles/oauth).

Before deployment, show the selected provider/account, domain/subdomain, artifact version, resource/cost estimate and credited amount, required DNS changes, and migration/rollback plan. Apply only Studio-owned records: preserve existing MX/TXT/other records and nameservers. For a Heroku target, use the actual platform-provided DNS target, not a hardcoded IP. [Heroku custom domains](https://devcenter.heroku.com/articles/custom-domains).

Status: research and task scoping only. No token requested in chat, account connected, resource provisioned, domain changed, or site deployed.
