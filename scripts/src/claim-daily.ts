import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Page, BrowserContext } from "playwright";

chromium.use(StealthPlugin());

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MM2BET_URL = "https://mm2.bet";
const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ??
  "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium";

if (!DISCORD_TOKEN) {
  console.error("[ERROR] DISCORD_TOKEN environment variable is not set.");
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
  "gn all",
  "hype",
  "good game everyone",
  "rip",
  "lets gooo",
  "gg wp",
  "so close",
  "almost",
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
  console.log("[INFO] Authorizing via Discord API...");
  const url = new URL(oauthUrl);
  const scope = url.searchParams.get("scope") ?? "identify email";
  const body = {
    authorize: true,
    permissions: "0",
    scope: scope.split(/[\s+]/),
  };

  const response = await fetch(
    `https://discord.com/api/v9/oauth2/authorize?${url.searchParams.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "X-Discord-Locale": "en-US",
        Referer: oauthUrl,
        Origin: "https://discord.com",
      },
      body: JSON.stringify(body),
    }
  );

  const text = await response.text();
  if (!response.ok) {
    console.error(`[ERROR] Discord auth failed: ${response.status} - ${text.slice(0, 500)}`);
    return null;
  }

  let data: { location?: string };
  try {
    data = JSON.parse(text) as { location?: string };
  } catch {
    console.error("[ERROR] Could not parse Discord response:", text.slice(0, 300));
    return null;
  }

  if (!data.location) {
    console.error("[ERROR] No redirect URL in Discord response:", JSON.stringify(data).slice(0, 300));
    return null;
  }

  console.log("[INFO] Got callback URL:", data.location.slice(0, 100));
  return data.location;
}

async function waitForCloudflare(page: Page, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const title = await page.title().catch(() => "");
    if (
      !title.toLowerCase().includes("just a moment") &&
      !title.toLowerCase().includes("checking")
    ) {
      return;
    }
    console.log("[INFO] Waiting for Cloudflare challenge...");
    await page.waitForTimeout(4000);
  }
}

async function login(page: Page): Promise<boolean> {
  console.log("[INFO] Navigating to mm2.bet...");
  await page.goto(MM2BET_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await waitForCloudflare(page);
  await page.waitForTimeout(3000);

  console.log("[INFO] Page title:", await page.title());

  const loginBtn = page
    .locator('button:has-text("Login"), a:has-text("Login"), a:has-text("Sign in")')
    .first();

  if (!(await loginBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
    console.log("[INFO] No login button — already logged in.");
    return true;
  }

  console.log("[INFO] Logging in with Discord...");

  let oauthUrl: string | null = null;

  page.on("response", async (response) => {
    const url = response.url();
    if (url.includes("discord.com") && url.includes("oauth2")) {
      console.log("[INFO] Intercepted OAuth URL:", url.slice(0, 100));
    }
  });

  await loginBtn.click();
  await page.waitForTimeout(3000);

  oauthUrl = extractOAuthUrl(page.url());
  if (!oauthUrl) {
    await page.waitForURL(/discord\.com/, { timeout: 10000 }).catch(() => {});
    oauthUrl = extractOAuthUrl(page.url());
  }

  if (!oauthUrl) {
    console.error("[ERROR] Could not get Discord OAuth URL. URL:", page.url().slice(0, 200));
    return false;
  }

  const callbackUrl = await authorizeDiscordOAuth(oauthUrl, DISCORD_TOKEN!);
  if (!callbackUrl) return false;

  console.log("[INFO] Navigating to mm2.bet callback...");
  await page.goto(callbackUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await waitForCloudflare(page);
  await page.waitForTimeout(4000);

  console.log("[INFO] Logged in — URL:", page.url());
  return true;
}

async function claimDailyReward(page: Page): Promise<void> {
  console.log("[INFO] Navigating to rewards page...");
  await page.goto(`${MM2BET_URL}/rewards`, { waitUntil: "networkidle", timeout: 30000 });
  await waitForCloudflare(page);
  await page.waitForTimeout(4000);

  await page.screenshot({ path: "/tmp/rewards-page.png" });

  const content = await page.content();
  const lower = content.toLowerCase();

  if (lower.includes("already claimed") || lower.includes("come back tomorrow")) {
    console.log("[INFO] Daily reward already claimed today.");
    return;
  }

  for (const sel of [
    'button:has-text("Daily")',
    '[role="tab"]:has-text("Daily")',
    'a:has-text("Daily")',
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) {
        const isActive =
          (await el.getAttribute("data-state")) ?? (await el.getAttribute("aria-selected"));
        if (isActive !== "active" && isActive !== "true") {
          await el.click();
          await page.waitForTimeout(2000);
        }
        break;
      }
    } catch {
      continue;
    }
  }

  for (const sel of [
    'button:has-text("Claim")',
    'button:has-text("CLAIM")',
    'button:has-text("Collect")',
    'button:has-text("COLLECT")',
    'button:has-text("Claim Reward")',
    'button:has-text("Claim Daily")',
    '[class*="claim"]:not([disabled])',
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) {
        if (await el.isDisabled()) {
          console.log("[INFO] Claim button disabled — already claimed today.");
          return;
        }
        await el.click();
        await page.waitForTimeout(3000);
        await page.screenshot({ path: "/tmp/after-claim.png" });
        console.log("[SUCCESS] Daily reward claimed!");
        return;
      }
    } catch {
      continue;
    }
  }

  const afterContent = await page.content();
  if (afterContent.includes("✓") || afterContent.toLowerCase().includes("claimed")) {
    console.log("[INFO] All daily rewards already claimed.");
    return;
  }

  console.log("[WARN] Could not find claim button — may already be claimed.");
}

async function getTokenBalance(page: Page): Promise<number> {
  try {
    await page.goto(MM2BET_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(3000);

    const html = await page.content();

    const patterns = [
      /(\d+\.?\d*)\s*tokens/i,
      /"balance"\s*:\s*([\d.]+)/i,
      /"coins"\s*:\s*([\d.]+)/i,
      /"amount"\s*:\s*([\d.]+)/i,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        const balance = parseFloat(match[1]);
        if (!isNaN(balance)) {
          console.log(`[INFO] Token balance: ${balance}`);
          return balance;
        }
      }
    }

    const headerText = await page
      .locator("header, nav, [class*='header'], [class*='nav']")
      .first()
      .innerText()
      .catch(() => "");

    const headerMatch = headerText.match(/(\d+\.?\d*)\s*tokens?/i);
    if (headerMatch) {
      const balance = parseFloat(headerMatch[1]);
      if (!isNaN(balance)) {
        console.log(`[INFO] Token balance from header: ${balance}`);
        return balance;
      }
    }
  } catch (err) {
    console.log("[WARN] Could not read balance:", (err as Error).message);
  }
  return 0;
}


async function sendChatMessages(page: Page, count = 3): Promise<void> {
  console.log(`[INFO] Sending ${count} chat messages...`);
  try {
    await page.goto(MM2BET_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
    await waitForCloudflare(page);
    await page.waitForTimeout(3000);

    const chatInputSelectors = [
      'input[placeholder*="message"]',
      'input[placeholder*="Message"]',
      'textarea[placeholder*="message"]',
      '[class*="chat"] input',
      '[class*="Chat"] input',
      '[class*="chat-input"]',
      'input[type="text"][class*="chat"]',
    ];

    let chatInput = null;
    for (const sel of chatInputSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 })) {
          chatInput = el;
          console.log(`[INFO] Found chat input: ${sel}`);
          break;
        }
      } catch {
        continue;
      }
    }

    if (!chatInput) {
      console.log("[WARN] Could not find chat input.");
      return;
    }

    for (let i = 0; i < count; i++) {
      const msg = randomItem(CHAT_MESSAGES);
      await chatInput.click();
      await chatInput.fill(msg);
      await page.keyboard.press("Enter");
      console.log(`[INFO] Sent chat message ${i + 1}/${count}: "${msg}"`);
      const waitTime = 10000 + Math.random() * 20000;
      await sleep(waitTime);
    }

    console.log("[INFO] Chat messages sent.");
  } catch (err) {
    console.log("[WARN] Chat failed:", (err as Error).message);
  }
}

async function createCoinflip(page: Page): Promise<void> {
  console.log("[INFO] Checking wallet and game config for coinflip...");
  try {
    await page.goto(`${MM2BET_URL}/games/coinflip`, { waitUntil: "networkidle", timeout: 30000 });
    await waitForCloudflare(page);
    await page.waitForTimeout(3000);

    type WalletData = { available_balance: number };
    type ConfigData = { coinflip: { min_bet_tokens: number; max_bet_tokens: number } };

    const { wallet, config } = await page.evaluate(async () => {
      const [walletRes, configRes] = await Promise.all([
        fetch("https://api.mm2.bet/api/wallet", {
          credentials: "include",
          headers: { "X-Requested-With": "XMLHttpRequest" },
        }),
        fetch("https://api.mm2.bet/api/games/config", {
          credentials: "include",
          headers: { "X-Requested-With": "XMLHttpRequest" },
        }),
      ]);
      return {
        wallet: (await walletRes.json()) as WalletData,
        config: (await configRes.json()) as ConfigData,
      };
    });

    const UNIT_FACTOR = 100000;
    const balanceTokens = wallet.available_balance / UNIT_FACTOR;
    const minBet = config.coinflip.min_bet_tokens;
    const maxBet = config.coinflip.max_bet_tokens;

    console.log(`[INFO] Balance: ${balanceTokens.toFixed(4)} tokens | Coinflip min: ${minBet} tokens`);

    if (balanceTokens < minBet) {
      console.log(`[INFO] Balance (${balanceTokens.toFixed(4)}) is below minimum bet (${minBet}). Skipping coinflip.`);
      return;
    }

    const betTokens = Math.min(Math.max(minBet, Math.floor(balanceTokens / 2)), maxBet);
    const betUnits = Math.round(betTokens * UNIT_FACTOR);
    const side = Math.random() > 0.5 ? "heads" : "tails";

    console.log(`[INFO] Creating coinflip: ${betTokens} tokens as ${side.toUpperCase()}...`);

    const result = await page.evaluate(
      async ({ betUnits, side }: { betUnits: number; side: string }) => {
        const res = await fetch("https://api.mm2.bet/api/games/coinflip", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: JSON.stringify({ side, amount: betUnits }),
        });
        const text = await res.text();
        return { status: res.status, body: text.slice(0, 500) };
      },
      { betUnits, side }
    );

    if (result.status === 200 || result.status === 201) {
      console.log(`[SUCCESS] Coinflip created! ${betTokens} tokens as ${side.toUpperCase()}`);
    } else {
      console.log(`[WARN] Coinflip API returned ${result.status}: ${result.body}`);

      if (result.body.includes("amount") || result.body.includes("min")) {
        const retryResult = await page.evaluate(
          async ({ betUnits, side }: { betUnits: number; side: string }) => {
            const res = await fetch("https://api.mm2.bet/api/games/coinflip", {
              method: "POST",
              credentials: "include",
              headers: {
                "Content-Type": "application/json",
                "X-Requested-With": "XMLHttpRequest",
              },
              body: JSON.stringify({ side, amount: betUnits }),
            });
            const text = await res.text();
            return { status: res.status, body: text.slice(0, 500) };
          },
          { betUnits: Math.round(minBet * UNIT_FACTOR), side }
        );
        console.log(`[INFO] Retry with min bet: status=${retryResult.status} ${retryResult.body}`);
      }
    }
  } catch (err) {
    console.log("[WARN] Coinflip creation failed:", (err as Error).message);
  }
}

async function run() {
  console.log(`\n[BOT] Starting at ${new Date().toISOString()}`);

  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROMIUM_PATH,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  const context: BrowserContext = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  try {
    const loggedIn = await login(page);
    if (!loggedIn) {
      console.error("[ERROR] Login failed.");
      process.exit(1);
    }

    await claimDailyReward(page);

    await sendChatMessages(page, 3);

    await createCoinflip(page);

    console.log("[BOT] Session complete.");
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error("[ERROR]", err);
  process.exit(1);
});
