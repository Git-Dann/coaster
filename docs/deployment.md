# Deployment

Static Vite build deployed to **Cloudflare Pages**.

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Output directory | `dist` |
| Node | 22 (`.nvmrc`; Vite 8 needs ≥ 20.19 / 22.12) |
| Production branch | `main` |
| Preview deployments | every other branch |

`public/_headers` sets the Content Security Policy, security headers, immutable caching for hashed `/assets/*`, and `no-cache` for HTML, the service worker, the precache manifest and the web manifest so updates are picked up.

## Current setup: Cloudflare Git integration

The Pages project **cozy-coaster** is connected to `Git-Dann/coaster` (created through the Cloudflare API on 2026-11-24). Production: https://cozy-coaster.pages.dev (from `main`). Each branch push gets a preview URL. GitHub Actions only runs checks.

### Recreating it

In the Cloudflare dashboard: Workers & Pages → Create → Pages → Connect to Git → select `Git-Dann/coaster`, framework preset *None*, build command `npm run build`, output `dist`, environment variable `NODE_VERSION=22`. Cloudflare then builds `main` to production and other branches to preview URLs.

## Alternative: deploy from GitHub Actions

If Git integration is ever disconnected, add a job that downloads the `dist` artifact and runs `npx wrangler@4 pages deploy dist --project-name=cozy-coaster --branch=$GITHUB_REF_NAME`, with two repository secrets:

- `CLOUDFLARE_API_TOKEN`: token with **Account → Cloudflare Pages → Edit**
- `CLOUDFLARE_ACCOUNT_ID`

Do not run both at once, or every push deploys twice.

## Service worker and updates

The build emits `precache-manifest.json` with a build id and the exact asset list. The worker caches that list under a versioned cache name, serves navigations network-first and hashed assets cache-first, and waits to activate until the player taps **Update** (after saves are flushed). Old caches are removed on activation, so engine and asset versions never mix.

## Verifying a deployment

```
E2E_BASE_URL=https://<deployment>.pages.dev npx playwright test --trace off
```

## Rollback

Cloudflare dashboard → the Pages project → Deployments → choose a previous production deployment → **Rollback to this deployment**. Or redeploy an earlier commit: `git checkout <sha> && npm ci && npm run build && npx wrangler pages deploy dist --project-name=cozy-coaster --branch=main`. Saves are local to each player's browser and versioned, so rollbacks never touch player data; a save written by a newer schema is refused politely by an older build rather than corrupted.
