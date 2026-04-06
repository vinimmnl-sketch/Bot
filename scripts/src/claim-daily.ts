import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

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

async function waitForCloudflare(page: import("playwright").Page, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const title = await page.title().catch(() => "");
    if (!title.toLowerCase().includes("just a moment") && !title.toLowerCase().includes("checking")) {
      return;
    }
    console.log("[INFO] Waiting for Cloudflare challenge...");
    await page.waitForTimeout(4000);
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

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  try {
    console.log("[INFO] Navigating to mm2.bet...");
    await page.goto(MM2BET_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await waitForCloudflare(page);
    await page.waitForTimeout(3000);

    console.log("[INFO] Page title:", await page.title());

    const loginBtn = page.locator('button:has-text("Login"), a:has-text("Login"), a:has-text("Sign in")').first();
    if (await loginBtn.isVisible({ timeout: 5000 })) {
      console.log("[INFO] Found login button, clicking...");

      let oauthUrl: string | null = null;

      page.on("response", async (response) => {
        const url = response.url();
        if (url.includes("discord.com") && url.includes("oauth2")) {
          console.log("[INFO] Intercepted OAuth URL:", url.slice(0, 150));
        }
      });

      await loginBtn.click();
      await page.waitForTimeout(3000);

      const currentUrl = page.url();
      console.log("[INFO] After login click, URL:", currentUrl.slice(0, 200));

      oauthUrl = extractOAuthUrl(currentUrl);

      if (!oauthUrl) {
        await page.waitForURL(/discord\.com/, { timeout: 10000 }).catch(() => {});
        const afterWait = page.url();
        oauthUrl = extractOAuthUrl(afterWait);
        console.log("[INFO] URL after wait:", afterWait.slice(0, 200));
      }

      if (!oauthUrl) {
        console.error("[ERROR] Could not get Discord OAuth URL.");
        await page.screenshot({ path: "/tmp/debug-login.png" });
        process.exit(1);
      }

      console.log("[INFO] OAuth URL found:", oauthUrl.slice(0, 150));

      const callbackUrl = await authorizeDiscordOAuth(oauthUrl, DISCORD_TOKEN!);
      if (!callbackUrl) {
        process.exit(1);
      }

      console.log("[INFO] Navigating to mm2.bet callback...");
      await page.goto(callbackUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await waitForCloudflare(page);
      await page.waitForTimeout(4000);

      console.log("[INFO] After callback — URL:", page.url(), "| Title:", await page.title());
    } else {
      console.log("[INFO] No login button found — may already be logged in.");
    }

    console.log("[INFO] Navigating to rewards page...");
    await page.goto(`${MM2BET_URL}/rewards`, { waitUntil: "networkidle", timeout: 30000 });
    await waitForCloudflare(page);
    await page.waitForTimeout(4000);

    console.log("[INFO] Rewards page URL:", page.url());
    await page.screenshot({ path: "/tmp/rewards-page.png" });

    const content = await page.content();
    const lower = content.toLowerCase();

    if (lower.includes("already claimed") || lower.includes("come back tomorrow")) {
      console.log("[INFO] Daily reward already claimed today. See you tomorrow!");
      process.exitCode = 0;
      return;
    }

    const dailyTabSelectors = [
      'button:has-text("Daily")',
      '[role="tab"]:has-text("Daily")',
      'a:has-text("Daily")',
    ];

    for (const sel of dailyTabSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 })) {
          const isActive = await el.getAttribute("data-state") ?? await el.getAttribute("aria-selected");
          if (isActive !== "active" && isActive !== "true") {
            console.log(`[INFO] Clicking Daily tab: ${sel}`);
            await el.click();
            await page.waitForTimeout(2000);
          }
          break;
        }
      } catch {
        continue;
      }
    }

    const claimSelectors = [
      'button:has-text("Claim")',
      'button:has-text("CLAIM")',
      'button:has-text("Collect")',
      'button:has-text("COLLECT")',
      'button:has-text("Claim Reward")',
      'button:has-text("Claim Daily")',
      '[class*="claim"]:not([disabled])',
    ];

    for (const sel of claimSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 })) {
          const isDisabled = await el.isDisabled();
          if (isDisabled) {
            console.log("[INFO] Claim button is disabled — reward already claimed today.");
            process.exitCode = 0;
            return;
          }
          console.log(`[INFO] Found & clicking: ${sel}`);
          await el.click();
          await page.waitForTimeout(3000);
          await page.screenshot({ path: "/tmp/after-claim.png" });
          console.log("[SUCCESS] Daily reward claimed!");
          process.exitCode = 0;
          return;
        }
      } catch {
        continue;
      }
    }

    const afterContent = await page.content();
    const allGreen = afterContent.includes("✓") || afterContent.toLowerCase().includes("claimed");
    if (allGreen) {
      console.log("[INFO] All daily rewards already claimed for today.");
      process.exitCode = 0;
      return;
    }

    console.log("[INFO] Page content sample:", afterContent.slice(0, 1000));
    console.error("[ERROR] Could not find claim button on rewards page.");
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error("[ERROR]", err);
  process.exit(1);
});
