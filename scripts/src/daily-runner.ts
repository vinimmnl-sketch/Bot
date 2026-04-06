import { execSync } from "child_process";

const HOURS_24 = 24 * 60 * 60 * 1000;
const CHAT_INTERVAL_MS = 3 * 60 * 60 * 1000; // chat every ~3 hours

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runScript(script: string, label: string) {
  console.log(`\n[SCHEDULER] Running ${label} at ${new Date().toISOString()}`);
  try {
    execSync(`npx tsx ./src/${script}`, {
      stdio: "inherit",
      env: process.env,
      cwd: process.cwd(),
    });
    console.log(`[SCHEDULER] ${label} completed.`);
  } catch (err) {
    console.error(`[SCHEDULER] ${label} failed:`, (err as Error).message?.slice(0, 200));
  }
}

async function main() {
  console.log("[SCHEDULER] mm2.bet bot scheduler started.");
  console.log("[SCHEDULER] Will claim daily reward + coinflip once per day.");
  console.log("[SCHEDULER] Will also chat every ~3 hours to stay active.");

  let lastDailyClaim = 0;
  let lastChat = 0;

  while (true) {
    const now = Date.now();

    if (now - lastDailyClaim >= HOURS_24) {
      runScript("claim-daily.ts", "daily claim + coinflip + chat");
      lastDailyClaim = Date.now();
      lastChat = Date.now();
    } else if (now - lastChat >= CHAT_INTERVAL_MS) {
      runScript("chat-only.ts", "chat session");
      lastChat = Date.now();
    }

    await sleep(60 * 1000);
  }
}

main();
