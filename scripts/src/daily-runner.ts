/**
 * Entry point for the mm2.bet chat-only workflow.
 * Delegates to the persistent service, which handles chat scheduling.
 */
import { execSync } from "child_process";

console.log("[RUNNER] Starting mm2.bet chat-only service...");

try {
  execSync("npx tsx ./src/bot-service.ts", {
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
  });
} catch (err) {
  console.error("[RUNNER] Bot service exited:", (err as Error).message?.slice(0, 200));
  process.exit(1);
}
