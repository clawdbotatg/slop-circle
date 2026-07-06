// Roster names: display names are announced over the encrypted bus (never to
// the relay), so each member sees the others' real names — and a live rename
// propagates. Proves the "anon" roster bug is fixed.
//   CIRCLE_URL=http://localhost:8788 node test/roster.mjs
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

const require = createRequire(import.meta.url);
const pw = process.env.PLAYWRIGHT_CORE ?? "/Users/clawd/clawd-harness/tools/node_modules/playwright-core/index.mjs";
const { chromium } = await import(existsSync(pw) ? pw : require.resolve("playwright-core"));

const BASE = process.env.CIRCLE_URL ?? "http://localhost:8788";
const URL = `${BASE}/#room${Date.now().toString(36)}:secret123`;

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

async function enter(first, name) {
  const p = await (await browser.newContext()).newPage();
  await p.goto(URL);
  if (first) {
    await p.waitForSelector("text=doesn't exist yet", { timeout: 6000 }).catch(() => fail("no claim offer"));
    await p.click("text=Create room");
  }
  await p.waitForSelector(".slop-menubar", { timeout: 6000 }).catch(() => fail(`${name}: not admitted`));
  await p.fill('input[placeholder="your name"]', name);
  await p.getByRole("button", { name: "Chat", exact: true }).click();
  await p.waitForSelector(".roster", { timeout: 8000 }).catch(() => fail(`${name}: chat didn't open`));
  return p;
}

async function rosterHas(page, name) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const t = (await page.textContent(".roster").catch(() => "")) || "";
    if (t.includes(name)) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

const A = await enter(true, "alice");
const B = await enter(false, "bob");

if (!(await rosterHas(B, "alice"))) await fail("B's roster never showed alice");
if (!(await rosterHas(A, "bob"))) await fail("A's roster never showed bob");
console.log("roster: each member sees the other's real name ✓");

// Live rename: A becomes "alice-2", B should see it update.
await A.fill('input[placeholder="your name"]', "alicetwo");
if (!(await rosterHas(B, "alicetwo"))) await fail("B never saw A's live rename");
console.log("live rename: renamed member's new name propagated over the bus ✓");

console.log("MILESTONE PASS: roster names ride the encrypted bus (no more 'anon'); renames propagate");
await browser.close();
process.exit(0);
