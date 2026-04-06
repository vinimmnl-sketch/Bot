import { execSync } from "child_process";

const HOURS_24 = 24 * 60 * 60 * 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runClaimScript() {
  console.log(`\n[SCHEDULER] Running daily reward claim at ${new Date().toISOString()}`);
  try {
    execSync("npx tsx ./src/claim-daily.ts", {
      stdio: "inherit",
      env: process.env,
      cwd: process.cwd(),
    });
    console.log("[SCHEDULER] Claim script completed.");
  } catch (err) {
    console.error("[SCHEDULER] Claim script failed:", err);
  }
}

async function main() {
  console.log("[SCHEDULER] mm2.bet daily reward scheduler started.");
  console.log("[SCHEDULER] Will claim once now, then every 24 hours.");

  while (true) {
    runClaimScript();
    console.log(`[SCHEDULER] Next claim in 24 hours (at ${new Date(Date.now() + HOURS_24).toISOString()})`);
    await sleep(HOURS_24);
  }
}

main();
