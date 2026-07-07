// Phase 2 foundation test: a passkey member gets a deterministic on-chain
// identity with no wallet software. Drives the real app with a virtual
// WebAuthn authenticator (CDP), so navigator.credentials.create resolves
// headlessly.
//
// PASS = creating a passkey yields a valid 0x address, it's shown as the
// signer, and it persists across reload (same identity).
//
//   CIRCLE_URL=http://host:port node test/passkey-identity.mjs
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const playwrightPath =
  process.env.PLAYWRIGHT_CORE ?? "/Users/clawd/clawd-harness/tools/node_modules/playwright-core/index.mjs";
const { chromium } = await import(existsSync(playwrightPath) ? playwrightPath : require.resolve("playwright-core"));

// WebAuthn needs a valid RP ID — a domain or "localhost", never a bare IP.
const BASE = process.env.CIRCLE_URL ?? "http://localhost:8788";
const SLUG = `p2pk${Date.now().toString(36)}`;
const ROOM_URL = `${BASE}/#${SLUG}:realsecret99`;

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

const ctx = await browser.newContext();
const page = await ctx.newPage();

// Install a virtual WebAuthn authenticator so credentials.create resolves.
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});

await page.goto(ROOM_URL);
await page.waitForSelector("text=doesn't exist yet", { timeout: 6000 }).catch(() => fail("no claim offer"));
await page.click("text=Create room");
await page.waitForSelector(".slop-menubar", { timeout: 6000 });

await page.locator(".slop-icon__btn", { hasText: "Wallet" }).dblclick();
await page.waitForSelector(".wallet-body", { timeout: 4000 });
await page.click("text=Create passkey identity");

// The signer address code element should appear with a valid 0x address.
await page.waitForSelector(".wallet-addr", { timeout: 8000 }).catch(() => fail("no passkey address rendered"));
const addr1 = (await page.textContent(".wallet-addr"))?.trim() ?? "";
if (!/^0x[0-9a-f]{40}$/i.test(addr1)) await fail(`invalid passkey address: "${addr1}"`);
console.log("passkey identity:", addr1);

// The passkey must be able to SIGN an exec hash, and the signature must
// cryptographically verify against its own public key (chain-free proof
// that the signing path — WebAuthn get, DER parse, low-S, encode — works).
await page.click("text=Test signer");
await page.waitForSelector(".wallet-signer-ok, .err", { timeout: 10000 });
const okShown = await page.$(".wallet-signer-ok");
if (!okShown) {
  const e = await page.textContent(".err").catch(() => "");
  await fail(`signer test did not pass: ${e}`);
}
console.log("signer self-verify: signature valid ✓");

// Persistence: reload, reopen wallet — same identity (loaded from storage).
await page.reload();
await page.waitForSelector(".slop-menubar", { timeout: 6000 }).catch(() => {});
// A reload lands on the join gate (fragment persists) → it re-auths and enters.
await page.waitForSelector(".slop-menubar", { timeout: 8000 }).catch(() => fail("did not re-enter room after reload"));
await page.locator(".slop-icon__btn", { hasText: "Wallet" }).dblclick();
await page.waitForSelector(".wallet-addr", { timeout: 6000 }).catch(() => fail("identity did not persist across reload"));
const addr2 = (await page.textContent(".wallet-addr"))?.trim() ?? "";
if (addr2 !== addr1) await fail(`identity changed across reload: ${addr1} -> ${addr2}`);

console.log("MILESTONE PASS: passkey identity created (no wallet, no server) and persisted:", addr2);
await browser.close();
process.exit(0);
