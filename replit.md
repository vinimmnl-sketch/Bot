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

Automates claiming the daily reward, sending live chat messages, and creating coinflip games on mm2.bet.

### How it works
1. Opens a headless Chromium browser with stealth mode (bypasses Cloudflare)
2. Navigates to mm2.bet and clicks the Login button
3. The site redirects to Discord OAuth — the bot intercepts the OAuth URL
4. Calls the Discord API directly with the user's Discord token to authorize
5. Gets the mm2.bet callback URL and navigates to it (now logged in)
6. Goes to `mm2.bet/rewards` → Daily tab and clicks the claim button
7. Sends 3 random chat messages (10–30s apart) for activity
8. Fetches wallet balance + games config via API (browser context, bypasses Cloudflare)
9. If balance ≥ 1 token (coinflip minimum), creates a coinflip for half balance
10. Runs full session once/day; chat-only sessions every ~3 hours

### mm2.bet API internals
- Wallet API: `GET https://api.mm2.bet/api/wallet` → `available_balance` in micro-units
- Unit conversion: `1 displayed token = 100,000 API units`
- Games config: `GET https://api.mm2.bet/api/games/config` → min/max bets per game
- Coinflip: `POST https://api.mm2.bet/api/games/coinflip` with `{ side, amount }` (amount in micro-units)
- CSRF header required: `X-Requested-With: XMLHttpRequest`
- Game URLs: `/games/coinflip`, `/games/jackpot`, `/games/minefield`
- Coinflip min: 1 token, Jackpot min: 1 token, Minefield min: 0.1 token

### Key files
- `scripts/src/claim-daily.ts` — main bot logic (single run): login, claim, chat, coinflip
- `scripts/src/daily-runner.ts` — scheduler: full session daily, chat-only every 3h
- `scripts/src/chat-only.ts` — standalone chat-only session

### Environment secrets
- `DISCORD_TOKEN` — the user's Discord account token (used for OAuth login)

### Workflow
- Workflow name: `mm2.bet Daily Reward Bot`
- Command: `pnpm --filter @workspace/scripts run daily-runner`
- Runs continuously

### Dependencies
- `playwright-extra` + `puppeteer-extra-plugin-stealth` — browser automation with Cloudflare bypass
- `chromium` system package (Nix) — provides the browser binary at `/nix/store/.../bin/chromium`

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
