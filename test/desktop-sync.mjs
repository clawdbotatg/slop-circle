// Shared desktop: like slop.computer, a circle is ONE computer everyone sees.
// Opening an app, moving its window, and minimizing all sync to every peer
// (over the encrypted bus; the relay stays blind). Proves the "windows aren't
// synced" bug is fixed.
//   CIRCLE_URL=http://localhost:8788 node test/desktop-sync.mjs
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

async function enter(first) {
  const p = await (await browser.newContext({ viewport: { width: 1100, height: 720 } })).newPage();
  await p.goto(URL);
  if (first) {
    await p.waitForSelector("text=doesn't exist yet", { timeout: 6000 }).catch(() => fail("no claim offer"));
    await p.click("text=Create room");
  }
  await p.waitForSelector(".slop-menubar", { timeout: 6000 }).catch(() => fail("not admitted"));
  return p;
}

// The .slop-window that contains a titlebar reading NOTES.
const notesWin = p => p.locator(".slop-window", { has: p.locator(".slop-titlebar__title", { hasText: "NOTES" }) });

const A = await enter(true);
const B = await enter(false);
await new Promise(r => setTimeout(r, 1500)); // let both desktop listeners register

// A opens Notes by double-clicking its desktop icon.
await A.locator(".slop-icon__btn", { hasText: "Notes" }).dblclick();

// It should open on B too (open state is shared).
const opened = await notesWin(B).first().waitFor({ state: "visible", timeout: 10000 }).then(() => true).catch(() => false);
if (!opened) await fail("Notes did not open on B (open state not synced)");
console.log("open synced: A opened Notes, it appeared on B ✓");

// Record B's window position, then drag A's window and watch B follow.
const before = await notesWin(B).first().boundingBox();
const bar = A.locator(".slop-window", { has: A.locator(".slop-titlebar__title", { hasText: "NOTES" }) }).locator(".slop-titlebar").first();
const bb = await bar.boundingBox();
await A.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
await A.mouse.down();
await A.mouse.move(bb.x + bb.width / 2 + 240, bb.y + bb.height / 2 + 140, { steps: 12 });
await A.mouse.up();

let after = before;
const deadline = Date.now() + 10000;
while (Date.now() < deadline) {
  after = await notesWin(B).first().boundingBox();
  if (after && Math.abs(after.x - before.x - 240) < 60 && Math.abs(after.y - before.y - 140) < 60) break;
  await new Promise(r => setTimeout(r, 300));
}
const dx = after.x - before.x;
const dy = after.y - before.y;
if (Math.abs(dx - 240) > 60 || Math.abs(dy - 140) > 60) await fail(`B's window did not follow A's move (dx=${dx.toFixed(0)} dy=${dy.toFixed(0)}, expected ~240,140)`);
console.log(`move synced: A dragged the window, B followed (dx=${dx.toFixed(0)} dy=${dy.toFixed(0)}) ✓`);

// A minimizes → B's window collapses to a titlebar pill.
const fullH = (await notesWin(B).first().boundingBox()).height;
await A.locator(".slop-window", { has: A.locator(".slop-titlebar__title", { hasText: "NOTES" }) }).locator(".slop-titlebar__dot--minimize").first().click();
let minH = fullH;
const md = Date.now() + 8000;
while (Date.now() < md) {
  minH = (await notesWin(B).first().boundingBox())?.height ?? fullH;
  if (minH < 40) break;
  await new Promise(r => setTimeout(r, 300));
}
if (minH >= 40) await fail(`B's window did not minimize (height stayed ${minH.toFixed(0)})`);
console.log(`minimize synced: A minimized, B collapsed to a ${minH.toFixed(0)}px pill ✓`);

console.log("MILESTONE PASS: shared desktop — open, move, and minimize all sync across peers (relay-blind)");
await browser.close();
process.exit(0);
