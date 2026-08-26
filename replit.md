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
- `pnpm --filter @workspace/scripts run daily-runner` — run the mm2.bet chat-only bot scheduler

## mm2.bet Chat Bot

Sends scheduled live chat messages on mm2.bet and reports chat activity to a Discord webhook.

### How it works
1. Opens a headless Chromium browser with stealth mode.
2. Navigates to mm2.bet and completes Discord OAuth using the secure token secret.
3. Sends a small batch of random chat messages, spaced apart.
4. Repeats the chat session every 3 hours and reports each message to the secure webhook.

Rewards, games, bets, rain, giveaways, scramble solving, and win/loss monitoring are disabled.

### Key files
- `scripts/src/bot-service.ts` — persistent chat-only service
- `scripts/src/daily-runner.ts` — workflow entry point for the chat-only service
- `scripts/src/chat-only.ts` — standalone chat-only session

### Environment secrets
- `DISCORD_TOKEN` — the user's Discord account token (used for OAuth login)
- `DISCORD_WEBHOOK_URL` — Discord webhook destination for chat activity embeds

### Workflow
- Workflow name: `mm2.bet Daily Reward Bot`
- Command: `pnpm --filter @workspace/scripts run daily-runner`
- Runs continuously in chat-only mode

### Dependencies
- `playwright-extra` + `puppeteer-extra-plugin-stealth` — browser automation with Cloudflare bypass
- `chromium` system package (Nix) — provides the browser binary at `/nix/store/.../bin/chromium`

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
