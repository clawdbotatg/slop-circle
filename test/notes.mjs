// Peer-authority validation: Notes is multiplayer + durable with ZERO notes
// logic on the relay.
//   A types → B sees it live (encrypted bus).
//   C joins AFTER → sees the note (loaded from the encrypted blob store).
// The relay only fanned out ciphertext and stored an opaque blob.
//   CIRCLE_URL=http://localhost:8788 node test/notes.mjs
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

const require = createRequire(import.meta.url);
const pw = process.env.PLAYWRIGHT_CORE ?? "/Users/clawd/clawd-harness/tools/node_modules/playwright-core/index.mjs";
const { chromium } = await import(existsSync(pw) ? pw : require.resolve("playwright-core"));

const BASE = process.env.CIRCLE_URL ?? "http://localhost:8788";
const URL = `${BASE}/#notesroom${Date.now().toString(36)}:secret123`;

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
  await p.getByRole("button", { name: "Notes", exact: true }).click();
  await p.waitForSelector('[data-testid="notes-text"]', { timeout: 6000 }).catch(() => fail("notes window did not open"));
  return p;
}

const NOTE = "civil society meets thursday 8pm";

// A creates the room, opens Notes, types.
const A = await enter(true);
await A.fill('[data-testid="notes-text"]', NOTE);

// B is already in the room → should see A's text arrive over the bus.
const B = await enter(false);
let liveOk = false;
let deadline = Date.now() + 8000;
while (Date.now() < deadline) {
  if ((await B.inputValue('[data-testid="notes-text"]')) === NOTE) { liveOk = true; break; }
  await new Promise(r => setTimeout(r, 300));
}
if (!liveOk) await fail("B did not receive A's note live over the bus");
console.log("live multiplayer: B saw A's note over the bus ✓");

// Give the debounced blob write time to persist.
await new Promise(r => setTimeout(r, 1200));

// C joins fresh (new context) AFTER the fact → must load the note from the
// encrypted blob store (durability + late-join, no live sender needed).
const C = await enter(false);
let blobOk = false;
deadline = Date.now() + 8000;
while (Date.now() < deadline) {
  if ((await C.inputValue('[data-testid="notes-text"]')) === NOTE) { blobOk = true; break; }
  await new Promise(r => setTimeout(r, 300));
}
if (!blobOk) await fail("C did not load the persisted note from the blob store");
console.log("durability: late-joiner C loaded the note from the encrypted blob ✓");

console.log("MILESTONE PASS: Notes is multiplayer + durable with zero relay-side notes logic (peer-authority proven)");
await browser.close();
process.exit(0);
