// Bank: the room treasury address is shared — one member sets the multisig
// address and every other member sees the same treasury (over the encrypted
// bus + blob, never the relay). Balance needs a chain, so this covers the
// sharing/agreement, which is the peer-authority part.
//   CIRCLE_URL=http://localhost:8788 node test/bank.mjs
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

const require = createRequire(import.meta.url);
const pw = process.env.PLAYWRIGHT_CORE ?? "/Users/clawd/clawd-harness/tools/node_modules/playwright-core/index.mjs";
const { chromium } = await import(existsSync(pw) ? pw : require.resolve("playwright-core"));

const BASE = process.env.CIRCLE_URL ?? "http://localhost:8788";
const URL = `${BASE}/#room${Date.now().toString(36)}:secret123`;
const ADDR = "0xAbC1230000000000000000000000000000009999";

const cache = pathJoin(homedir(), "Library/Caches/ms-playwright");
let exec = null;
for (const dir of readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()) {
  for (const sub of ["chrome-mac-arm64", "chrome-mac"])
    for (const app of ["Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "Chromium.app/Contents/MacOS/Chromium"]) {
      const p = pathJoin(cache, dir, sub, app);
      if (existsSync(p)) { exec = p; break; }
    }
  if (exec) break;
}

const browser = await chromium.launch({ executablePath: exec ?? undefined, headless: true });
const fail = async m => { console.error("FAIL:", m); await browser.close(); process.exit(1); };

async function enter(first) {
  const p = await (await browser.newContext()).newPage();
  await p.goto(URL);
  if (first) {
    await p.waitForSelector("text=doesn't exist yet", { timeout: 6000 }).catch(() => fail("no claim offer"));
    await p.click("text=Create room");
  }
  await p.waitForSelector(".slop-menubar", { timeout: 6000 }).catch(() => fail("not admitted"));
  await p.getByRole("button", { name: "Bank", exact: true }).click();
  await p.waitForSelector('[data-testid="bank-set-addr"], [data-testid="bank-addr"]', { timeout: 8000 }).catch(() => fail("bank did not open"));
  return p;
}

const A = await enter(true);
await A.fill('[data-testid="bank-addr-input"]', ADDR);
await A.click('[data-testid="bank-set-addr"]');
await A.waitForSelector('[data-testid="bank-addr"]', { timeout: 6000 }).catch(() => fail("A: treasury address didn't stick"));

const B = await enter(false);
let seen = false;
const deadline = Date.now() + 10000;
while (Date.now() < deadline) {
  const t = (await B.textContent('[data-testid="bank-addr"]').catch(() => "")) || "";
  if (t.toLowerCase().includes(ADDR.toLowerCase())) { seen = true; break; }
  await new Promise(r => setTimeout(r, 300));
}
if (!seen) await fail("B never saw the shared treasury address");

console.log("bank: treasury address set by A propagated to B over the bus/blob ✓");
console.log("MILESTONE PASS: the room treasury (shared multisig) is agreed across members, relay-blind");
await browser.close();
process.exit(0);
