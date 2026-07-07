// CRDT merge: two members editing at the same time both keep their edits, and
// the docs converge. Under the old last-write-wins one side's edits would be
// clobbered; the Yjs CRDT merges them. Proves the upgrade.
//   CIRCLE_URL=http://localhost:8788 node test/notes-crdt.mjs
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
const T = '[data-testid="notes-text"]';

async function enter(first) {
  const p = await (await browser.newContext()).newPage();
  await p.goto(URL);
  if (first) {
    await p.waitForSelector("text=doesn't exist yet", { timeout: 6000 }).catch(() => fail("no claim offer"));
    await p.click("text=Create room");
  }
  await p.waitForSelector(".slop-menubar", { timeout: 6000 }).catch(() => fail("not admitted"));
  await p.locator(".slop-icon__btn", { hasText: "Notes" }).dblclick();
  await p.waitForSelector(T, { timeout: 8000 }).catch(() => fail("notes did not open"));
  return p;
}

const A = await enter(true);
const B = await enter(false);

// Let both peers' bus listeners register before the first edit — live updates
// are delivered only to already-subscribed peers (durability/late-join is
// covered by the blob + sync-request, exercised in notes.mjs).
await new Promise(r => setTimeout(r, 1500));

// Shared base, then wait for B to catch up.
await A.fill(T, "MIDDLE");
const baseDeadline = Date.now() + 12000;
while (Date.now() < baseDeadline && (await B.inputValue(T)) !== "MIDDLE") await new Promise(r => setTimeout(r, 200));
if ((await B.inputValue(T)) !== "MIDDLE") await fail("B never synced the base text");

// Concurrent edits: A appends AAA, B appends BBB — issued together, before
// either has seen the other's, so the CRDT must merge them.
await Promise.all([A.click(T), B.click(T)]);
await Promise.all([A.press(T, "End"), B.press(T, "End")]);
await Promise.all([A.type(T, "AAA", { delay: 20 }), B.type(T, "BBB", { delay: 20 })]);

// Wait for convergence.
let a = "", b = "";
const deadline = Date.now() + 12000;
while (Date.now() < deadline) {
  a = await A.inputValue(T);
  b = await B.inputValue(T);
  if (a === b && /A/.test(a) && /B/.test(a)) break;
  await new Promise(r => setTimeout(r, 300));
}

const countA = (a.match(/A/g) || []).length;
const countB = (a.match(/B/g) || []).length;
if (a !== b) await fail(`docs did not converge: A=${JSON.stringify(a)} B=${JSON.stringify(b)}`);
if (!a.startsWith("MIDDLE")) await fail(`base text lost: ${JSON.stringify(a)}`);
if (countA !== 3 || countB !== 3) await fail(`edits clobbered — expected 3 A's + 3 B's, got ${countA} A / ${countB} B in ${JSON.stringify(a)}`);

console.log(`converged: both members show ${JSON.stringify(a)} — 3 A's + 3 B's, base intact ✓`);
console.log("MILESTONE PASS: concurrent edits merge via the CRDT (no last-write-wins clobber)");
await browser.close();
process.exit(0);
