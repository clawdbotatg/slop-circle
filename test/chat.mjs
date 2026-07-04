// Encrypted chat over the room bus: a message from one member appears for
// the other (proving the encrypted group bus round-trips through the relay).
//   CIRCLE_URL=http://localhost:8788 node test/chat.mjs
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

async function enter(tag, first) {
  const p = await (await browser.newContext()).newPage();
  await p.goto(URL);
  if (first) {
    await p.waitForSelector("text=doesn't exist yet", { timeout: 6000 }).catch(() => fail("no claim offer"));
    await p.click("text=Create room");
  }
  await p.waitForSelector("header .roomname", { timeout: 6000 }).catch(() => fail(`${tag}: not admitted`));
  // Exact button match — a plain text=Chat can match the room name in the
  // header if the room slug happens to contain "chat".
  await p.getByRole("button", { name: "Chat", exact: true }).click();
  const ok = await p
    .waitForSelector('[data-testid="chat-input"]', { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) await fail(`${tag}: chat panel did not open`);
  return p;
}

const A = await enter("A", true);
const B = await enter("B", false);
const MSG = "circle up at 8?";
await A.fill('[data-testid="chat-input"]', MSG);
await A.click('[data-testid="chat-send"]');

let seen = false;
const deadline = Date.now() + 8000;
while (Date.now() < deadline) {
  const t = (await B.textContent(".chat-log").catch(() => "")) || "";
  if (t.includes(MSG)) { seen = true; break; }
  await new Promise(r => setTimeout(r, 300));
}
if (!seen) await fail("B never received A's chat message");
console.log("MILESTONE PASS: encrypted chat delivered over the room bus");
await browser.close();
process.exit(0);
