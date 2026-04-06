# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/scripts run claim-daily` — manually run the mm2.bet daily reward bot once
- `pnpm --filter @workspace/scripts run daily-runner` — run the bot scheduler (claims daily, repeats every 24h)

## mm2.bet Daily Reward Bot

Automates claiming the daily reward on mm2.bet every 24 hours.

### How it works
1. Opens a headless Chromium browser with stealth mode (bypasses Cloudflare)
2. Navigates to mm2.bet and clicks the Login button
3. The site redirects to Discord OAuth — the bot intercepts the OAuth URL
4. Calls the Discord API directly with the user's Discord token to authorize
5. Gets the mm2.bet callback URL and navigates to it (now logged in)
6. Goes to mm2.bet/rewards → Daily tab and clicks the claim button
7. Sleeps 24 hours and repeats

### Key files
- `scripts/src/claim-daily.ts` — main bot logic (single run)
- `scripts/src/daily-runner.ts` — scheduler that loops every 24 hours

### Environment secrets
- `DISCORD_TOKEN` — the user's Discord account token (used for OAuth login)

### Workflow
- Workflow name: `mm2.bet Daily Reward Bot`
- Command: `pnpm --filter @workspace/scripts run daily-runner`
- Runs continuously; claims once, then waits 24 hours

### Dependencies
- `playwright-extra` + `puppeteer-extra-plugin-stealth` — browser automation with Cloudflare bypass
- `chromium` system package (Nix) — provides the browser binary at `/nix/store/.../bin/chromium`

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
