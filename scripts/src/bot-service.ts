/**
 * mm2.bet chat-only bot service.
 *
 * The service deliberately does one thing: log in and send chat messages on a
 * schedule. It does not visit rewards or game pages, place bets, join events,
 * solve scrambles, or monitor game results.
 */

import express from "express";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { BrowserContext, Page } from "playwright";
import { execSync } from "child_process";

chromium.use(StealthPlugin());

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const MM2BET_URL = "https://mm2.bet";
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const CHAT_INTERVAL_MS = 3 * 60 * 60 * 1000;
const MESSAGE_DELAY_MIN_MS = 12 * 1000;
const MESSAGE_DELAY_MAX_MS = 30 * 1000;
const RECONNECT_DELAY_MS = 30 * 1000;

if (!DISCORD_TOKEN) {
  console.error("[ERROR] DISCORD_TOKEN is not set.");
  process.exit(1);
}

if (!DISCORD_WEBHOOK_URL) {
  console.error("[ERROR] DISCORD_WEBHOOK_URL is not set.");
  process.exit(1);
}

const WEBHOOK_URL: string = DISCORD_WEBHOOK_URL;

function findChromium(): string {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;

  const candidates = [
    "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ];

  for (const candidate of candidates) {
    try {
      execSync(`test -x "${candidate}"`, { stdio: "ignore" });
      return candidate;
    } catch {}
  }

  try {
    return execSync("which chromium || which chromium-browser || which google-chrome 2>/dev/null", {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

const CHROMIUM_PATH = findChromium();
const botStartTime = Date.now();
let botStatus = "Starting";
let lastChatAt = 0;
let messagesSent = 0;
let sessionsCompleted = 0;
let accountLabel = "mm2.bet account";

const CHAT_MESSAGES = [
  "gl everyone",
  "gg",
  "lets go!",
  "good luck",
  "nice one",
  "wp",
  "lets get it",
  "letsgooo",
  "nice",
  "gz",
  "let's go",
  "hype",
  "gg wp",
  "so close",
  "almost",
  "rip",
  "lets gooo",
  "good game everyone",
  "gn all",
];

const CHAT_INPUT_SELECTORS = [
  'input[placeholder*="message"]',
  'input[placeholder*="Message"]',
  'textarea[placeholder*="message"]',
  '[class*="chat"] input',
  '[class*="Chat"] input',
];

const COLORS = {
  green: 0x00d26a,
  blue: 0x5865f2,
  orange: 0xff8c00,
  red: 0xed4245,
};

interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields?: EmbedField[];
  footer?: { text: string };
  timestamp?: string;
}

function randomItem<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uptime(): string {
  const totalMinutes = Math.floor((Date.now() - botStartTime) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

let webhookQueue: DiscordEmbed[] = [];
let webhookSending = false;

async function flushWebhookQueue(): Promise<void> {
  if (webhookSending || webhookQueue.length === 0) return;
  webhookSending = true;

  while (webhookQueue.length > 0) {
    const embed = webhookQueue.shift();
    if (!embed) continue;

    try {
      const response = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      });

      if (!response.ok) {
        console.error(`[WEBHOOK] Discord returned ${response.status}.`);
      }
    } catch (error) {
      console.error("[WEBHOOK] Could not send notification:", (error as Error).message);
    }

    if (webhookQueue.length > 0) await sleep(1000);
  }

  webhookSending = false;
}

function sendWebhook(embed: DiscordEmbed): void {
  webhookQueue.push({
    ...embed,
    timestamp: new Date().toISOString(),
    footer: { text: `mm2.bet Chat Bot • Uptime: ${uptime()} • Messages: ${messagesSent}` },
  });
  flushWebhookQueue().catch((error) => {
    console.error("[WEBHOOK] Queue error:", (error as Error).message);
  });
}

const app = express();

app.get("/", (_request, response) => {
  response.send("Chat bot is alive! ✅");
});

app.get("/status", (_request, response) => {
  response.json({
    status: botStatus,
    uptime: uptime(),
    account: accountLabel,
    messagesSent,
    sessionsCompleted,
    lastChat: lastChatAt ? new Date(lastChatAt).toISOString() : null,
  });
});

app.listen(PORT, () => {
  console.log(`[BOT] Chat-only keep-alive server listening on :${PORT}`);
});

function extractOAuthUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const redirectTo = url.searchParams.get("redirect_to");
    if (redirectTo) {
      const decoded = decodeURIComponent(redirectTo);
      if (decoded.includes("oauth2/authorize")) return `https://discord.com${decoded}`;
    }
    if (rawUrl.includes("oauth2/authorize")) return rawUrl;
  } catch {}
  return null;
}

async function authorizeDiscordOAuth(oauthUrl: string): Promise<string | null> {
  const url = new URL(oauthUrl);
  const scope = url.searchParams.get("scope") ?? "identify email";
  const response = await fetch(
    `https://discord.com/api/v9/oauth2/authorize?${url.searchParams.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: DISCORD_TOKEN,
        "Content-Type": "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36",
        Referer: oauthUrl,
        Origin: "https://discord.com",
      },
      body: JSON.stringify({
        authorize: true,
        permissions: "0",
        scope: scope.split(/[\s+]/),
      }),
    },
  );

  if (!response.ok) {
    console.error(`[LOGIN] Discord authorization returned ${response.status}.`);
    return null;
  }

  const data = (await response.json()) as { location?: string };
  return data.location ?? null;
}

async function waitForCloudflare(page: Page, timeout = 30000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const title = await page.title().catch(() => "");
    if (!title.toLowerCase().includes("just a moment") && !title.toLowerCase().includes("checking")) {
      return;
    }
    await page.waitForTimeout(4000);
  }
}

async function login(page: Page, context: BrowserContext): Promise<boolean> {
  botStatus = "Logging in";
  console.log("[BOT] Opening mm2.bet...");
  await page.goto(MM2BET_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await waitForCloudflare(page);
  await page.waitForTimeout(3000);

  const signedIn = await page
    .locator('[class*="avatar"], [class*="balance"]')
    .first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);

  if (signedIn) {
    console.log("[BOT] Already logged in.");
    return true;
  }

  const directChatSignIn = page.getByRole("button", {
    name: "Sign in with Discord to chat",
    exact: true,
  });
  const topSignIn = page.locator(
    'button:has-text("Login"), a:has-text("Login"), button:has-text("Sign In")',
  ).first();
  const signInButton = (await directChatSignIn.isVisible({ timeout: 3000 }).catch(() => false))
    ? directChatSignIn
    : topSignIn;

  if (!(await signInButton.isVisible({ timeout: 5000 }).catch(() => false))) {
    console.error("[LOGIN] Login button was not found.");
    return false;
  }

  let oauthUrl: string | null = null;
  const requestListener = (request: { url: () => string }) => {
    const candidate = extractOAuthUrl(request.url());
    if (candidate) oauthUrl = candidate;
  };

  page.on("request", requestListener);
  const popupPromise = context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
  await signInButton.click();
  await page.waitForTimeout(1000);

  const continueWithDiscord = page.getByRole("button", {
    name: /Continue with Discord/i,
  }).last();
  if (await continueWithDiscord.isVisible({ timeout: 3000 }).catch(() => false)) {
    await continueWithDiscord.click();
  }

  const popup = await popupPromise;
  const authPage = popup ?? page;
  if (authPage !== page) authPage.on("request", requestListener);

  oauthUrl = extractOAuthUrl(authPage.url()) ?? extractOAuthUrl(page.url());
  if (!oauthUrl) {
    await authPage.waitForURL(/discord\.com/, { timeout: 10000 }).catch(() => {});
    oauthUrl = extractOAuthUrl(authPage.url()) ?? extractOAuthUrl(page.url());
  }

  let waited = 0;
  while (!oauthUrl && waited < 10000) {
    await sleep(300);
    waited += 300;
  }
  page.off("request", requestListener);
  if (authPage !== page) authPage.off("request", requestListener);

  if (!oauthUrl) {
    const describePage = (candidate: Page) => {
      try {
        const url = new URL(candidate.url());
        return `${url.hostname}${url.pathname}`;
      } catch {
        return "unknown";
      }
    };
    console.error(
      `[LOGIN] Discord OAuth URL was not found (page=${describePage(page)}, auth=${describePage(authPage)}).`,
    );
    return false;
  }

  const callbackUrl = await authorizeDiscordOAuth(oauthUrl);
  if (!callbackUrl) return false;

  await page.goto(callbackUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await waitForCloudflare(page);
  await page.waitForTimeout(4000);

  const loggedIn = page.url().includes("mm2.bet");
  if (loggedIn) console.log("[BOT] Logged in successfully.");
  return loggedIn;
}

async function findChatInput(page: Page) {
  for (const selector of CHAT_INPUT_SELECTORS) {
    const input = page.locator(selector).first();
    if (await input.isVisible({ timeout: 2000 }).catch(() => false)) return input;
  }
  return null;
}

async function sendChatMessage(page: Page, message: string): Promise<boolean> {
  const input = await findChatInput(page);
  if (!input) return false;

  await input.click();
  await input.fill(message);
  await page.keyboard.press("Enter");
  await sleep(500);
  return true;
}

async function runChatSession(page: Page, count = 3): Promise<void> {
  botStatus = "Sending chat";
  if (!page.url().includes("mm2.bet")) {
    await page.goto(MM2BET_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
    await waitForCloudflare(page);
    await page.waitForTimeout(2000);
  }

  const input = await findChatInput(page);
  if (!input) {
    console.error("[CHAT] Chat input was not found.");
    sendWebhook({
      title: "⚠️ Chat Input Unavailable",
      description: "The bot is logged in but could not find the mm2.bet chat input.",
      color: COLORS.red,
    });
    return;
  }

  let sentThisSession = 0;
  for (let index = 0; index < count; index++) {
    const message = randomItem(CHAT_MESSAGES);
    const sent = await sendChatMessage(page, message);
    if (!sent) {
      console.error("[CHAT] Message could not be sent.");
      sendWebhook({
        title: "⚠️ Chat Message Failed",
        description: "The bot could not send the next chat message.",
        color: COLORS.red,
      });
      break;
    }

    sentThisSession++;
    messagesSent++;
    console.log(`[CHAT] Sent (${index + 1}/${count}): "${message}"`);
    sendWebhook({
      title: "💬 Chat Message Sent",
      description: "The chat-only bot sent a message on mm2.bet.",
      color: COLORS.blue,
      fields: [
        { name: "📝 Message", value: message, inline: false },
        { name: "📨 Total Sent", value: String(messagesSent), inline: true },
        { name: "👤 Account", value: accountLabel, inline: true },
      ],
    });

    if (index < count - 1) {
      await sleep(
        MESSAGE_DELAY_MIN_MS +
          Math.random() * (MESSAGE_DELAY_MAX_MS - MESSAGE_DELAY_MIN_MS),
      );
    }
  }

  if (sentThisSession > 0) {
    lastChatAt = Date.now();
    sessionsCompleted++;
    sendWebhook({
      title: "✅ Chat Session Complete",
      description: `Sent ${sentThisSession} message${sentThisSession === 1 ? "" : "s"} successfully.`,
      color: COLORS.green,
      fields: [
        { name: "📨 Session Messages", value: String(sentThisSession), inline: true },
        { name: "📊 Total Messages", value: String(messagesSent), inline: true },
      ],
    });
  }
  botStatus = "Waiting for next chat session";
}

async function main(): Promise<void> {
  console.log("[BOT SERVICE] Starting mm2.bet chat-only bot...");
  sendWebhook({
    title: "🤖 Chat-Only Bot Started",
    description: "The bot is running and will only send scheduled chat messages.",
    color: COLORS.green,
    fields: [
      { name: "💬 Mode", value: "Chat only", inline: true },
      { name: "⏱️ Schedule", value: "Every 3 hours", inline: true },
      { name: "🚫 Disabled", value: "Rewards, games, bets, event joins, scramble solving, and result tracking", inline: false },
    ],
  });

  while (true) {
    const browser = await chromium.launch({
      headless: true,
      ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });

    try {
      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();

      const loggedIn = await login(page, context);
      if (!loggedIn) {
        botStatus = "Login failed; retrying";
        sendWebhook({
          title: "⚠️ Login Failed",
          description: `The bot will retry in ${RECONNECT_DELAY_MS / 1000} seconds.`,
          color: COLORS.red,
        });
        await browser.close();
        await sleep(RECONNECT_DELAY_MS);
        continue;
      }

      accountLabel = "Authenticated mm2.bet account";
      sendWebhook({
        title: "🔐 Account Connected",
        description: "The chat-only bot is logged in and ready.",
        color: COLORS.green,
      });

      await runChatSession(page);

      let nextChatAt = Date.now() + CHAT_INTERVAL_MS;
      while (true) {
        const waitMs = Math.max(5000, nextChatAt - Date.now());
        await sleep(Math.min(waitMs, 30000));

        const stillSignedIn = Boolean(await findChatInput(page));

        if (!stillSignedIn) {
          console.log("[BOT] Login session expired; reconnecting.");
          break;
        }

        if (Date.now() >= nextChatAt) {
          await runChatSession(page);
          nextChatAt = Date.now() + CHAT_INTERVAL_MS;
        }
      }
    } catch (error) {
      botStatus = "Restarting after error";
      console.error("[BOT] Error:", (error as Error).message);
      sendWebhook({
        title: "🔄 Chat Bot Restarting",
        description: "The bot encountered an error and will reconnect.",
        color: COLORS.orange,
        fields: [{ name: "❗ Error", value: (error as Error).message.slice(0, 200) || "Unknown error" }],
      });
    } finally {
      await browser.close().catch(() => {});
    }

    botStatus = "Reconnecting";
    await sleep(RECONNECT_DELAY_MS);
  }
}

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exit(1);
});