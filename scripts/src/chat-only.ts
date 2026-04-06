import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Page } from "playwright";

chromium.use(StealthPlugin());

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MM2BET_URL = "https://mm2.bet";
const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ??
  "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium";

if (!DISCORD_TOKEN) {
  console.error("[ERROR] DISCORD_TOKEN not set.");
  process.exit(1);
}

const CHAT_MESSAGES = [
  "gl everyone",
  "gg",
  "lets go!",
  "good luck",
  "nice one",
  "wp",
  "any coinflips?",
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

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractOAuthUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const redirectTo = url.searchParams.get("redirect_to");
    if (redirectTo) {
      const decoded = decodeURIComponent(redirectTo);
      if (decoded.includes("oauth2/authorize")) {
        return `https://discord.com${decoded}`;
      }
    }
    if (rawUrl.includes("oauth2/authorize")) return rawUrl;
  } catch {}
  return null;
}

async function authorizeDiscordOAuth(oauthUrl: string, token: string): Promise<string | null> {
  const url = new URL(oauthUrl);
  const scope = url.searchParams.get("scope") ?? "identify email";
  const body = { authorize: true, permissions: "0", scope: scope.split(/[\s+]/) };

  const res = await fetch(
    `https://discord.com/api/v9/oauth2/authorize?${url.searchParams.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        Referer: oauthUrl,
        Origin: "https://discord.com",
      },
      body: JSON.stringify(body),
    }
  );

  const text = await res.text();
  if (!res.ok) return null;
  const data = JSON.parse(text) as { location?: string };
  return data.location ?? null;
}

async function waitForCloudflare(page: Page, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const title = await page.title().catch(() => "");
    if (!title.toLowerCase().includes("just a moment") && !title.toLowerCase().includes("checking")) return;
    await page.waitForTimeout(4000);
  }
}

async function run() {
  console.log(`\n[CHAT] Starting chat session at ${new Date().toISOString()}`);

  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROMIUM_PATH,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  try {
    await page.goto(MM2BET_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await waitForCloudflare(page);
    await page.waitForTimeout(3000);

    const loginBtn = page.locator('button:has-text("Login"), a:has-text("Login")').first();
    if (await loginBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await loginBtn.click();
      await page.waitForTimeout(3000);

      let oauthUrl = extractOAuthUrl(page.url());
      if (!oauthUrl) {
        await page.waitForURL(/discord\.com/, { timeout: 10000 }).catch(() => {});
        oauthUrl = extractOAuthUrl(page.url());
      }

      if (!oauthUrl) {
        console.error("[CHAT] Could not get OAuth URL.");
        return;
      }

      const callbackUrl = await authorizeDiscordOAuth(oauthUrl, DISCORD_TOKEN!);
      if (!callbackUrl) return;

      await page.goto(callbackUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await waitForCloudflare(page);
      await page.waitForTimeout(4000);
    }

    const chatInputSelectors = [
      'input[placeholder*="message"]',
      'input[placeholder*="Message"]',
      'textarea[placeholder*="message"]',
      '[class*="chat"] input',
      '[class*="Chat"] input',
    ];

    let chatInput = null;
    for (const sel of chatInputSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 })) {
          chatInput = el;
          break;
        }
      } catch { continue; }
    }

    if (!chatInput) {
      console.log("[CHAT] Could not find chat input.");
      return;
    }

    const msgCount = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < msgCount; i++) {
      const msg = randomItem(CHAT_MESSAGES);
      await chatInput.click();
      await chatInput.fill(msg);
      await page.keyboard.press("Enter");
      console.log(`[CHAT] Sent: "${msg}"`);
      await sleep(12000 + Math.random() * 18000);
    }

    console.log("[CHAT] Chat session done.");
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error("[CHAT ERROR]", err);
  process.exit(1);
});
