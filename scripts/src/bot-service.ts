/**
 * mm2.bet Persistent Bot Service
 * - Express keepalive server (ping with UptimeRobot for 24/7)
 * - Discord webhook notifications for every action
 * - Scramble word solver via Socket.IO WebSocket monitoring
 * - Rain / giveaway / event auto-joiner
 * - Daily reward, coinflip, periodic chat
 */

import express from "express";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Page, WebSocket } from "playwright";
import { solveScramble } from "./dictionary.js";
import { execSync } from "child_process";

chromium.use(StealthPlugin());

// ─── Config ───────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MM2BET_URL = "https://mm2.bet";
const API_BASE = "https://api.mm2.bet";
const WEBHOOK_URL =
  "https://discord.com/api/webhooks/1490799299314061322/F606rnhKhBRCdRJ7-XzvFtYK2HxDfxC_Kx6baXzE2Cmi5qmO2o6Efuv6YAjT_cmzlBGl";
const PORT = parseInt(process.env.PORT ?? "3000");

if (!DISCORD_TOKEN) {
  console.error("[ERROR] DISCORD_TOKEN not set.");
  process.exit(1);
}

// ─── Find Chromium ────────────────────────────────────────────────────────────
function findChromium(): string {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = [
    "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ];
  for (const p of candidates) {
    try { execSync(`test -x "${p}"`, { stdio: "ignore" }); return p; } catch {}
  }
  try {
    const f = execSync("which chromium || which chromium-browser || which google-chrome 2>/dev/null", { encoding: "utf8" }).trim();
    if (f) return f;
  } catch {}
  return "";
}
const CHROMIUM_PATH = findChromium();

// ─── Bot state ────────────────────────────────────────────────────────────────
let lastDailyClaim = 0;
let lastChat = 0;
let activeScramble: { word: string; answeredAt: number } | null = null;
let lastRainJoined = "";
let lastGiveawayJoined = "";
let myUserId = 2008; // discovered dynamically after login
let myUsername = "Ken";
let lastCoinflipUid = "";
let botStatus = "Starting...";
const botStartTime = new Date();
const stats = { wins: 0, losses: 0, wagered: 0, earned: 0, scramblesAnswered: 0, rainJoins: 0, giveawayJoins: 0 };

// ─── Timing ───────────────────────────────────────────────────────────────────
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHAT_INTERVAL_MS = 3 * 60 * 60 * 1000;
const EVENT_POLL_INTERVAL_MS = 8000;
const RECONNECT_DELAY_MS = 30000;

// ─── Chat messages ────────────────────────────────────────────────────────────
const CHAT_MESSAGES = [
  "gl everyone", "gg", "lets go!", "good luck", "nice one", "wp",
  "any coinflips?", "lets get it", "letsgooo", "nice", "gz",
  "let's go", "hype", "good game everyone", "rip", "gg wp",
  "so close", "almost", "anyone wanna coinflip?", "lets gooo",
];

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function uptime(): string {
  const ms = Date.now() - botStartTime.getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

// ─── Discord Webhook ──────────────────────────────────────────────────────────
const COLORS = {
  green:  0x00d26a,
  red:    0xff4444,
  orange: 0xff8c00,
  yellow: 0xffd700,
  blue:   0x0099ff,
  purple: 0x9b59b6,
  pink:   0xff69b4,
  cyan:   0x00bcd4,
  gray:   0x95a5a6,
  gold:   0xf1c40f,
};

interface EmbedField { name: string; value: string; inline?: boolean }
interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields?: EmbedField[];
  footer?: { text: string };
  timestamp?: string;
  thumbnail?: { url: string };
}

let webhookQueue: DiscordEmbed[] = [];
let webhookSending = false;

async function flushWebhookQueue(): Promise<void> {
  if (webhookSending || webhookQueue.length === 0) return;
  webhookSending = true;
  while (webhookQueue.length > 0) {
    const embed = webhookQueue.shift()!;
    try {
      await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      });
    } catch {}
    if (webhookQueue.length > 0) await sleep(1000); // rate limit guard
  }
  webhookSending = false;
}

function sendWebhook(embed: DiscordEmbed): void {
  embed.timestamp = new Date().toISOString();
  embed.footer = { text: `mm2.bet Bot • Uptime: ${uptime()} • W:${stats.wins} L:${stats.losses}` };
  webhookQueue.push(embed);
  flushWebhookQueue().catch(() => {});
}

// ─── Express keepalive server ─────────────────────────────────────────────────
const app = express();

app.get("/", (_req, res) => {
  res.send("Bot is alive! ✅");
});

app.get("/status", (_req, res) => {
  res.json({
    status: botStatus,
    uptime: uptime(),
    user: myUsername,
    stats,
    lastDailyClaim: lastDailyClaim ? new Date(lastDailyClaim).toISOString() : null,
    lastChat: lastChat ? new Date(lastChat).toISOString() : null,
  });
});

app.listen(PORT, () => {
  console.log(`[BOT] Keep-alive server on :${PORT} — point UptimeRobot here`);
});

// ─── Login ────────────────────────────────────────────────────────────────────
async function login(page: Page): Promise<boolean> {
  console.log("[BOT] Navigating to mm2.bet...");
  await page.goto(MM2BET_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  const signedIn = await page.locator('[class*="avatar"], [class*="balance"]').first().isVisible({ timeout: 3000 }).catch(() => false);
  if (signedIn) { console.log("[BOT] Already logged in."); return true; }

  const loginBtn = page.locator('button:has-text("Login"), button:has-text("Sign In")').first();
  if (!(await loginBtn.isVisible({ timeout: 5000 }))) return false;

  let oauthUrl: string | null = null;
  const listener = (req: { url: () => string }) => {
    const u = req.url();
    if (u.includes("discord.com") && u.includes("oauth2/authorize")) oauthUrl = u;
  };
  page.on("request", listener);
  await loginBtn.click();
  let waited = 0;
  while (!oauthUrl && waited < 10000) { await sleep(300); waited += 300; }
  page.off("request", listener);
  if (!oauthUrl) return false;

  const url = new URL(oauthUrl);
  const scope = url.searchParams.get("scope") ?? "identify email";
  const res = await fetch(`https://discord.com/api/v9/oauth2/authorize?${url.searchParams.toString()}`, {
    method: "POST",
    headers: { Authorization: DISCORD_TOKEN!, "Content-Type": "application/json", "User-Agent": "Mozilla/5.0", Referer: oauthUrl, Origin: "https://discord.com" },
    body: JSON.stringify({ authorize: true, permissions: "0", scope: scope.split(/[\s+]/) }),
  });
  const data = await res.json() as { location?: string };
  if (!data.location) return false;

  await page.goto(data.location, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  // Fetch my user info
  const me = await apiCall<{ id: number; username: string }>(page, "/api/auth/me");
  if (me?.id) { myUserId = me.id; myUsername = me.username ?? myUsername; }

  console.log(`[BOT] Logged in as ${myUsername} (id:${myUserId})`);
  return page.url().includes("mm2.bet");
}

// ─── API helper ───────────────────────────────────────────────────────────────
async function apiCall<T>(page: Page, path: string, method = "GET", body?: unknown): Promise<T | null> {
  return page.evaluate(
    async ({ path, method, body, base }: { path: string; method: string; body: unknown; base: string }) => {
      const res = await fetch(`${base}${path}`, {
        method,
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return res.json().catch(() => null);
    },
    { path, method, body, base: API_BASE }
  ) as Promise<T | null>;
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
async function sendChat(page: Page, message: string): Promise<boolean> {
  try {
    const input = page.locator('input[placeholder*="message"]').first();
    if (!(await input.isVisible({ timeout: 3000 }))) {
      await page.goto(MM2BET_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(2000);
    }
    await input.click();
    await input.fill(message);
    await page.keyboard.press("Enter");
    await sleep(500);
    return true;
  } catch { return false; }
}

async function runChatSession(page: Page, count = 3): Promise<void> {
  console.log(`[CHAT] Sending ${count} messages...`);
  if (!page.url().includes("mm2.bet")) {
    await page.goto(MM2BET_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(3000);
  }
  const input = page.locator('input[placeholder*="message"]').first();
  if (!(await input.isVisible({ timeout: 5000 }))) { console.log("[WARN] No chat input."); return; }

  const sent: string[] = [];
  for (let i = 0; i < count; i++) {
    const msg = randomItem(CHAT_MESSAGES);
    await input.click();
    await input.fill(msg);
    await page.keyboard.press("Enter");
    sent.push(msg);
    console.log(`[CHAT] (${i + 1}/${count}): "${msg}"`);
    await sleep(12000 + Math.random() * 18000);
  }
  lastChat = Date.now();

  sendWebhook({
    title: "💬 Chat Session Complete",
    description: `Sent **${count}** messages to stay active`,
    color: COLORS.blue,
    fields: sent.map((m, i) => ({ name: `Message ${i + 1}`, value: `"${m}"`, inline: true })),
  });
}

// ─── Daily reward ─────────────────────────────────────────────────────────────
async function claimDailyReward(page: Page): Promise<void> {
  console.log("[DAILY] Claiming...");
  try {
    await page.goto(`${MM2BET_URL}/rewards`, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(3000);

    const dailyTab = page.locator('button:has-text("Daily"), [role="tab"]:has-text("Daily")').first();
    if (await dailyTab.isVisible({ timeout: 3000 })) await dailyTab.click();
    await page.waitForTimeout(1500);

    // Get streak info
    const streakEl = await page.locator('[class*="streak"], [class*="day"]').first().innerText().catch(() => "");

    const claimBtn = page.locator('button:has-text("Claim"), button:has-text("CLAIM")').first();
    if (await claimBtn.isVisible({ timeout: 5000 }) && !(await claimBtn.isDisabled())) {
      await claimBtn.click();
      await page.waitForTimeout(3000);
      console.log("[DAILY] Claimed!");
      sendWebhook({
        title: "🎁 Daily Reward Claimed!",
        description: "Successfully claimed today's daily reward",
        color: COLORS.gold,
        fields: [
          { name: "👤 Account", value: myUsername, inline: true },
          { name: "📆 Streak Info", value: streakEl || "Active streak", inline: true },
        ],
      });
    } else {
      console.log("[DAILY] Already claimed.");
      sendWebhook({
        title: "📅 Daily Already Claimed",
        description: "Today's reward was already claimed — will check again tomorrow",
        color: COLORS.gray,
        fields: [{ name: "👤 Account", value: myUsername, inline: true }],
      });
    }
  } catch (err) {
    console.log("[DAILY] Error:", (err as Error).message);
  }
}

// ─── Coinflip ─────────────────────────────────────────────────────────────────
async function createCoinflip(page: Page): Promise<void> {
  console.log("[COINFLIP] Checking balance...");
  try {
    await page.goto(`${MM2BET_URL}/games/coinflip`, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(3000);

    type WalletData = { available_balance: number };
    type ConfigData = { coinflip: { min_bet_tokens: number; max_bet_tokens: number } };

    const { wallet, config } = await page.evaluate(async (base: string) => {
      const [w, c] = await Promise.all([
        fetch(`${base}/api/wallet`, { credentials: "include", headers: { "X-Requested-With": "XMLHttpRequest" } }),
        fetch(`${base}/api/games/config`, { credentials: "include", headers: { "X-Requested-With": "XMLHttpRequest" } }),
      ]);
      return { wallet: await w.json() as WalletData, config: await c.json() as ConfigData };
    }, API_BASE);

    const balanceTokens = wallet.available_balance / 100000;
    const minBet = config.coinflip.min_bet_tokens;
    const maxBet = config.coinflip.max_bet_tokens;

    console.log(`[COINFLIP] Balance: ${balanceTokens.toFixed(4)} | Min: ${minBet}`);
    if (balanceTokens < minBet) {
      console.log("[COINFLIP] Balance below minimum. Skipping.");
      sendWebhook({
        title: "🎲 Coinflip Skipped",
        description: `Balance **${balanceTokens.toFixed(4)}** tokens is below the minimum bet of **${minBet}** token`,
        color: COLORS.gray,
        fields: [{ name: "💰 Balance", value: `${balanceTokens.toFixed(4)} tokens`, inline: true }],
      });
      return;
    }

    const betTokens = Math.min(Math.max(minBet, Math.floor(balanceTokens / 2)), maxBet);
    const side = Math.random() > 0.5 ? "heads" : "tails";
    const sideEmoji = side === "heads" ? "🟠" : "🔵";

    console.log(`[COINFLIP] Creating ${betTokens} tokens as ${side.toUpperCase()}...`);
    const result = await page.evaluate(
      async ({ betTokens, side, base }: { betTokens: number; side: string; base: string }) => {
        const res = await fetch(`${base}/api/games/coinflip`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
          body: JSON.stringify({ side, amount: betTokens }),
        });
        const text = await res.text();
        return { status: res.status, body: text.slice(0, 500) };
      },
      { betTokens, side, base: API_BASE }
    );

    if (result.status === 200 || result.status === 201) {
      console.log(`[COINFLIP] Created! ${betTokens} tokens as ${side.toUpperCase()}`);
      stats.wagered += betTokens;

      // Try to get game uid from response
      try {
        const parsed = JSON.parse(result.body) as { game?: { uid?: string } };
        if (parsed.game?.uid) lastCoinflipUid = parsed.game.uid;
      } catch {}

      sendWebhook({
        title: `🎲 Coinflip Created!`,
        description: `Waiting for someone to join your coinflip`,
        color: COLORS.orange,
        fields: [
          { name: `${sideEmoji} Side`, value: side.toUpperCase(), inline: true },
          { name: "💰 Bet", value: `${betTokens} tokens`, inline: true },
          { name: "⚖️ Balance Before", value: `${balanceTokens.toFixed(2)} tokens`, inline: true },
        ],
      });
    } else {
      console.log(`[COINFLIP] Failed ${result.status}: ${result.body}`);
      sendWebhook({
        title: "⚠️ Coinflip Error",
        description: `API returned ${result.status}`,
        color: COLORS.red,
        fields: [{ name: "Response", value: `\`\`\`${result.body.slice(0, 200)}\`\`\`` }],
      });
    }
  } catch (err) {
    console.log("[COINFLIP] Error:", (err as Error).message);
  }
}

// ─── Scramble ─────────────────────────────────────────────────────────────────
function parseScrambleFromFrame(payload: string): string | null {
  try {
    if (!payload.startsWith("42")) return null;
    const json = JSON.parse(payload.slice(2)) as [string, unknown];
    if (!Array.isArray(json) || json.length < 2) return null;
    const [eventName, data] = json;

    if (typeof eventName === "string" && /scramble/i.test(eventName)) {
      const d = data as Record<string, unknown>;
      const word = String(d.word ?? d.scrambled_word ?? d.scrambled ?? d.letters ?? "");
      if (word) return word;
    }
    if (eventName === "chat_event" && typeof data === "object" && data !== null) {
      const d = data as Record<string, unknown>;
      if (typeof d.type === "string" && /scramble/i.test(d.type)) {
        return String(d.word ?? d.scrambled_word ?? d.letters ?? "");
      }
    }
    if (eventName === "new_message" && typeof data === "object" && data !== null) {
      const d = data as Record<string, unknown>;
      const user = d.user as Record<string, unknown> | undefined;
      const isStaff = user?.is_owner || user?.is_dev || user?.is_admin || user?.is_manager;
      const msg = String(d.message ?? d.text ?? d.content ?? "");
      if (isStaff || /scramble|unscramble|🔤|word is/i.test(msg)) {
        const after = msg.match(/(?:scramble|unscramble|word is|🔤)[:\s]+([a-zA-Z]{3,12})/i);
        const bold = msg.match(/\*\*([a-zA-Z]{3,12})\*\*/);
        const caps = msg.match(/\b([A-Z]{4,12})\b/);
        const word = (after?.[1] ?? bold?.[1] ?? caps?.[1] ?? "").trim();
        if (word) return word;
      }
    }
  } catch {}
  return null;
}

// Parse coinflip result from WS frame
function parseCoinflipResult(payload: string): { uid: string; winnerId: number; creatorId: number; joinerId: number | null; amount: number; creatorUsername: string; joinerUsername: string } | null {
  try {
    if (!payload.startsWith("42")) return null;
    const json = JSON.parse(payload.slice(2)) as [string, unknown];
    if (!Array.isArray(json) || json.length < 2) return null;
    const [eventName, data] = json;
    if (eventName !== "coinflip:game_result") return null;
    const d = data as Record<string, unknown>;
    const game = d.game as Record<string, unknown>;
    if (!game) return null;
    const creator = game.creator as Record<string, unknown> | undefined;
    const joiner = game.joiner as Record<string, unknown> | undefined;
    return {
      uid: String(game.uid ?? ""),
      winnerId: Number(game.winner_id ?? game.winner ?? 0),
      creatorId: Number(creator?.id ?? 0),
      joinerId: joiner ? Number(joiner.id) : null,
      amount: Number(game.creator_amount ?? 0) / 100000,
      creatorUsername: String(creator?.username ?? "?"),
      joinerUsername: String(joiner?.username ?? "?"),
    };
  } catch { return null; }
}

async function handleScramble(page: Page, scrambledWord: string): Promise<void> {
  const now = Date.now();
  if (activeScramble?.word === scrambledWord && now - activeScramble.answeredAt < 60000) return;

  const answer = solveScramble(scrambledWord);
  if (!answer) {
    console.log(`[SCRAMBLE] Can't solve: "${scrambledWord}"`);
    sendWebhook({
      title: "🔤 Scramble Detected (Unsolved)",
      description: `Could not find an answer for the scrambled word`,
      color: COLORS.gray,
      fields: [{ name: "🔀 Scrambled", value: `\`${scrambledWord}\``, inline: true }],
    });
    return;
  }

  console.log(`[SCRAMBLE] "${scrambledWord}" → "${answer}"`);
  activeScramble = { word: scrambledWord, answeredAt: now };
  await sleep(300 + Math.random() * 700);
  const sent = await sendChat(page, answer);
  if (sent) {
    stats.scramblesAnswered++;
    sendWebhook({
      title: "🔤 Scramble Solved!",
      description: `Answered the scramble puzzle in chat`,
      color: COLORS.purple,
      fields: [
        { name: "🔀 Scrambled", value: `\`${scrambledWord}\``, inline: true },
        { name: "✅ Answer", value: `**${answer}**`, inline: true },
        { name: "🏆 Total Solved", value: String(stats.scramblesAnswered), inline: true },
      ],
    });
  }
}

// ─── Events ───────────────────────────────────────────────────────────────────
async function checkAndJoinEvents(page: Page): Promise<void> {
  try {
    type RainData = { rain: { id: string; status: string; amount?: number } | null };
    type GiveawayData = { giveaway: { id: string; status: string; prize?: number } | null };
    type ChatEventData = { event: { id: string; type: string; scrambled_word?: string } | null };

    const [rainData, giveawayData, chatEventData] = await Promise.all([
      apiCall<RainData>(page, "/api/rain/active"),
      apiCall<GiveawayData>(page, "/api/chat-giveaway/active"),
      apiCall<ChatEventData>(page, "/api/chat-events/active"),
    ]);

    if (rainData?.rain && rainData.rain.status === "active") {
      const rainId = String(rainData.rain.id);
      if (rainId !== lastRainJoined) {
        console.log("[RAIN] Joining...");
        const result = await apiCall<{ success?: boolean; error?: unknown }>(page, "/api/rain/join", "POST", { rain_id: rainId });
        lastRainJoined = rainId;
        stats.rainJoins++;
        if (!result?.error) {
          sendWebhook({
            title: "🌧️ Rain Joined!",
            description: "Joined the active token rain — free tokens incoming!",
            color: COLORS.cyan,
            fields: [
              { name: "🎯 Rain ID", value: rainId, inline: true },
              { name: "🌧️ Total Joined", value: String(stats.rainJoins), inline: true },
            ],
          });
        }
      }
    }

    if (giveawayData?.giveaway && giveawayData.giveaway.status === "active") {
      const id = String(giveawayData.giveaway.id);
      if (id !== lastGiveawayJoined) {
        console.log("[GIVEAWAY] Joining...");
        await apiCall(page, "/api/chat-giveaway/enter", "POST", { giveaway_id: id });
        lastGiveawayJoined = id;
        stats.giveawayJoins++;
        sendWebhook({
          title: "🎁 Giveaway Entered!",
          description: "Entered the active chat giveaway — fingers crossed!",
          color: COLORS.pink,
          fields: [
            { name: "🎫 Giveaway ID", value: id, inline: true },
            { name: "🎁 Total Entered", value: String(stats.giveawayJoins), inline: true },
          ],
        });
      }
    }

    if (chatEventData?.event) {
      const ev = chatEventData.event;
      if (/scramble/i.test(ev.type ?? "") && ev.scrambled_word) {
        await handleScramble(page, ev.scrambled_word);
      }
    }
  } catch {}
}

// ─── WebSocket monitor ────────────────────────────────────────────────────────
function setupWsMonitor(page: Page) {
  page.on("websocket", (ws: WebSocket) => {
    ws.on("framereceived", async (frame) => {
      const payload = frame.payload.toString();

      // Scramble detection
      const scrambledWord = parseScrambleFromFrame(payload);
      if (scrambledWord) {
        await handleScramble(page, scrambledWord).catch(() => {});
      }

      // Coinflip result
      const cfResult = parseCoinflipResult(payload);
      if (cfResult) {
        const botInvolved = cfResult.creatorId === myUserId || cfResult.joinerId === myUserId;
        if (botInvolved) {
          const botWon = cfResult.winnerId === myUserId;
          const opponent = cfResult.creatorId === myUserId ? cfResult.joinerUsername : cfResult.creatorUsername;
          if (botWon) {
            stats.wins++;
            stats.earned += cfResult.amount;
            console.log(`[COINFLIP] WON! +${cfResult.amount} tokens vs ${opponent}`);
            sendWebhook({
              title: "🏆 Coinflip WON!",
              description: `Beat **${opponent}** and won the coinflip!`,
              color: COLORS.green,
              fields: [
                { name: "💰 Won", value: `+${cfResult.amount.toFixed(2)} tokens`, inline: true },
                { name: "😈 Opponent", value: opponent, inline: true },
                { name: "📊 W/L Record", value: `${stats.wins}W / ${stats.losses}L`, inline: true },
              ],
            });
          } else {
            stats.losses++;
            console.log(`[COINFLIP] Lost ${cfResult.amount} tokens vs ${opponent}`);
            sendWebhook({
              title: "💸 Coinflip Lost",
              description: `Lost to **${opponent}** in the coinflip`,
              color: COLORS.red,
              fields: [
                { name: "💸 Lost", value: `-${cfResult.amount.toFixed(2)} tokens`, inline: true },
                { name: "😤 Opponent", value: opponent, inline: true },
                { name: "📊 W/L Record", value: `${stats.wins}W / ${stats.losses}L`, inline: true },
              ],
            });
          }
        }
      }

      // Someone joined your coinflip
      if (payload.includes("coinflip:game_joined") && lastCoinflipUid) {
        try {
          const json = JSON.parse(payload.slice(2)) as [string, { game?: Record<string, unknown> }];
          const game = json[1]?.game as Record<string, unknown> | undefined;
          if (game?.uid === lastCoinflipUid) {
            const joiner = game.joiner as Record<string, unknown> | undefined;
            const joinerName = String(joiner?.username ?? "Someone");
            console.log(`[COINFLIP] ${joinerName} joined your game!`);
            sendWebhook({
              title: "⚔️ Coinflip Joined!",
              description: `**${joinerName}** joined your coinflip — deciding fate...`,
              color: COLORS.yellow,
              fields: [{ name: "🕹️ Opponent", value: joinerName, inline: true }],
            });
          }
        } catch {}
      }
    });
  });
}

// ─── Daily task runner ────────────────────────────────────────────────────────
async function runDailyTasks(page: Page): Promise<void> {
  console.log("\n[SCHEDULER] Running daily tasks...");
  botStatus = "Running daily tasks";
  await claimDailyReward(page);
  await page.goto(MM2BET_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(2000);
  await runChatSession(page, 3);
  await createCoinflip(page);
  await page.goto(MM2BET_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(2000);
  lastDailyClaim = Date.now();
  lastChat = Date.now();
  botStatus = "Polling for events";
  console.log("[SCHEDULER] Daily tasks complete.");
}

// ─── Main loop ────────────────────────────────────────────────────────────────
async function main() {
  console.log("[BOT SERVICE] Starting mm2.bet bot...");

  sendWebhook({
    title: "🤖 mm2.bet Bot Started",
    description: "Bot is now running and monitoring for events 24/7",
    color: COLORS.green,
    fields: [
      { name: "🎮 Features", value: "Daily Claim • Coinflip • Chat • Scramble Solver • Rain/Giveaway Joiner", inline: false },
      { name: "⏰ Schedule", value: "Daily tasks every 24h • Chat every 3h • Events polled every 8s", inline: false },
    ],
  });

  while (true) {
    const browser = await chromium.launch({
      headless: true,
      ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });

    try {
      const page = await browser.newPage();
      setupWsMonitor(page);
      botStatus = "Logging in";

      const loggedIn = await login(page);
      if (!loggedIn) {
        console.log("[BOT] Login failed. Retrying in 30s...");
        sendWebhook({ title: "⚠️ Login Failed", description: "Will retry in 30 seconds", color: COLORS.red });
        await browser.close();
        await sleep(RECONNECT_DELAY_MS);
        continue;
      }

      botStatus = "Running daily tasks";
      await runDailyTasks(page);

      let pollCount = 0;
      while (true) {
        await sleep(EVENT_POLL_INTERVAL_MS);
        pollCount++;

        await checkAndJoinEvents(page);

        const now = Date.now();
        if (now - lastDailyClaim >= DAILY_INTERVAL_MS) {
          await runDailyTasks(page);
        } else if (now - lastChat >= CHAT_INTERVAL_MS) {
          await page.goto(MM2BET_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
          await page.waitForTimeout(2000);
          await runChatSession(page, 3);
        }

        // Re-login check every ~30 min
        if (pollCount % 225 === 0) {
          const ok = await page.locator('[class*="balance"], [class*="avatar"]').first().isVisible({ timeout: 5000 }).catch(() => false);
          if (!ok) {
            console.log("[BOT] Session expired — re-logging in...");
            await login(page);
          }
        }
      }
    } catch (err) {
      console.log("[BOT] Crash:", (err as Error).message);
      sendWebhook({
        title: "🔄 Bot Restarting",
        description: `Encountered an error — restarting in 30 seconds`,
        color: COLORS.orange,
        fields: [{ name: "❗ Error", value: (err as Error).message?.slice(0, 200) ?? "Unknown" }],
      });
    } finally {
      await browser.close().catch(() => {});
    }

    botStatus = "Reconnecting...";
    await sleep(RECONNECT_DELAY_MS);
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
