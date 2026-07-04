// Phase 2 milestone: the circle co-signs. Two members (each with their own
// passkey) share a wallet; one proposes a transaction, both sign it over the
// encrypted room bus, and both reach threshold — "ready to execute". This is
// the collaborative multisig, chain-free (counterfactual nonce 0); only the
// final on-chain broadcast needs a funded key.
//
//   CIRCLE_URL=http://localhost:8788 node test/cosign.mjs
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const playwrightPath =
  process.env.PLAYWRIGHT_CORE ?? "/Users/clawd/clawd-harness/tools/node_modules/playwright-core/index.mjs";
const { chromium } = await import(existsSync(playwrightPath) ? playwrightPath : require.resolve("playwright-core"));

// WebAuthn needs localhost, not a bare IP.
const BASE = process.env.CIRCLE_URL ?? "http://localhost:8788";
const SLUG = `cosign${Date.now().toString(36)}`;
const ROOM_URL = `${BASE}/#${SLUG}:realsecret99`;
const ROOM_WALLET = "0x1111111111111111111111111111111111111111"; // stand-in room multisig
const RECIPIENT = "0x2222222222222222222222222222222222222222";

const cache = join(homedir(), "Library/Caches/ms-playwright");
let exec = null;
for (const dir of readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()) {
  for (const sub of ["chrome-mac-arm64", "chrome-mac"]) {
    for (const app of [
      "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "Chromium.app/Contents/MacOS/Chromium",
    ]) {
      const p = join(cache, dir, sub, app);
      if (existsSync(p)) { exec = p; break; }
    }
    if (exec) break;
  }
  if (exec) break;
}

const browser = await chromium.launch({
  executablePath: exec ?? undefined,
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const fail = async m => { console.error("FAIL:", m); await browser.close(); process.exit(1); };

async function member(first) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.goto(ROOM_URL);
  if (first) {
    await page.waitForSelector("text=doesn't exist yet", { timeout: 6000 }).catch(() => fail("no claim offer"));
    await page.click("text=Create room");
  }
  await page.waitForSelector("header .roomname", { timeout: 6000 }).catch(() => fail("not admitted"));
  await page.click("text=Wallet");
  await page.waitForSelector(".wallet-panel", { timeout: 4000 });
  await page.click("text=Create passkey identity");
  await page.waitForSelector(".wallet-addr", { timeout: 8000 });
  return page;
}

const A = await member(true);
const B = await member(false);
console.log("two members joined with passkeys");

// A proposes a send from the shared wallet (threshold 2).
await A.fill('input[placeholder="room wallet (multisig) address 0x…"]', ROOM_WALLET);
await A.fill('input[placeholder="send to 0x…"]', RECIPIENT);
await A.fill('input[placeholder="amount"]', "0.01");
await A.click('[data-testid="propose"]');

// The proposal should appear for BOTH members over the bus.
await A.waitForSelector('[data-testid="proposal"]', { timeout: 6000 }).catch(() => fail("A: proposal not shown"));
await B.waitForSelector('[data-testid="proposal"]', { timeout: 6000 }).catch(() => fail("B: proposal did not arrive over the bus"));
console.log("proposal broadcast to both members");

// Each member signs with their own passkey.
await A.click('[data-testid="proposal"] button');
await new Promise(r => setTimeout(r, 800));
await B.click('[data-testid="proposal"] button');

// Both should converge on 2/2 signed → ready to execute.
const readyOn = async (page, who) => {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const txt = (await page.textContent('[data-testid="sigcount"]').catch(() => "")) ?? "";
    if (/2\s*\/\s*2 signed/.test(txt) && /ready to execute/.test(txt)) return txt.trim();
    await new Promise(r => setTimeout(r, 400));
  }
  await fail(`${who} did not reach 2/2 ready (last: "${await page.textContent('[data-testid="sigcount"]').catch(() => "")}")`);
};
console.log("A:", await readyOn(A, "A"));
console.log("B:", await readyOn(B, "B"));

console.log("MILESTONE PASS: two passkey members co-signed a shared-wallet proposal to threshold over the encrypted bus");
await browser.close();
process.exit(0);
