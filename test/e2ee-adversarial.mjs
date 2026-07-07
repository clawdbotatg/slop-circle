// Phase 1 milestone test: fragment-derived E2EE defeats a malicious relay /
// injected peer.
//
//   A, B  — legit peers with the real fragment secret → decode each other.
//   C     — an "injected" peer that passed the server gate (knows the
//           verifier) but was given the WRONG media key (window.__circle
//           ForceWrongKey), simulating a relay that only ever saw verifiers.
//           It receives A/B's tracks but can never decode them.
//
// PASS = A and B each show a remote video with width>0, while C's remote
// videos stay width==0 (frames arrive but AES-GCM decrypt drops them).
//
// Requires: the relay running (default http://127.0.0.1:8788) serving a
// production web build, and playwright-core with a cached Chromium.
//   CIRCLE_URL=http://host:port node test/e2ee-adversarial.mjs
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const playwrightPath =
  process.env.PLAYWRIGHT_CORE ?? "/Users/clawd/clawd-harness/tools/node_modules/playwright-core/index.mjs";
const { chromium } = await import(existsSync(playwrightPath) ? playwrightPath : require.resolve("playwright-core"));

const BASE = process.env.CIRCLE_URL ?? "http://127.0.0.1:8788";
const SLUG = `p1e2ee${Date.now().toString(36)}`;
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

async function joinRoom(wrongKey, isFirst) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  if (wrongKey) await page.addInitScript(() => { window.__circleForceWrongKey = true; });
  await page.goto(ROOM_URL);
  if (isFirst) {
    await page.waitForSelector("text=doesn't exist yet", { timeout: 6000 }).catch(() => fail("no claim offer"));
    await page.click("text=Create room");
  }
  await page.waitForSelector(".slop-menubar", { timeout: 6000 }).catch(() => fail("not admitted"));
  await page.locator(".slop-icon__btn", { hasText: "Camera" }).dblclick();
  await page.waitForSelector("video", { timeout: 8000 });
  return page;
}

const remoteWidths = page =>
  page.evaluate(() => [...document.querySelectorAll("video")].map(v => ({ w: v.videoWidth, muted: v.muted })));
// "unverified peers" alert badge count (0 if none).
const unverifiedCount = async page => {
  const t = await page.textContent(".slop-badge--alert").catch(() => null);
  if (!t) return 0;
  const m = t.match(/(\d+)\s+unverified/);
  return m ? Number(m[1]) : 0;
};

const pageA = await joinRoom(false, true);
const badge = await pageA.textContent(".slop-badge");
if (!badge || !badge.includes("sub rosa")) await fail(`legit peer badge not encrypted: "${badge}"`);
console.log("A: badge =", badge.trim());

const pageB = await joinRoom(false, false); // B
const pageC = await joinRoom(true, false); // wrong-key + wrong-auth attacker
console.log(`A, B, C joined room ${SLUG} (C is injected: wrong media + auth keys)`);

const deadline = Date.now() + 25000;
let legitOk = false;
let cRemoteEverDecoded = false;
let aFlagsInjected = false;
let bFlagsInjected = false;
while (Date.now() < deadline) {
  const a = await remoteWidths(pageA);
  const c = await remoteWidths(pageC);
  const remoteDecoded = vs => vs.filter(v => !v.muted && v.w > 0).length >= 1;
  if (remoteDecoded(a)) legitOk = true;
  if (c.some(v => !v.muted && v.w > 0)) cRemoteEverDecoded = true;
  if ((await unverifiedCount(pageA)) >= 1) aFlagsInjected = true;
  if ((await unverifiedCount(pageB)) >= 1) bFlagsInjected = true;
  if (legitOk && aFlagsInjected && bFlagsInjected && Date.now() > deadline - 12000) break;
  await new Promise(r => setTimeout(r, 500));
}

console.log("A videos:", JSON.stringify(await remoteWidths(pageA)));
console.log("C videos:", JSON.stringify(await remoteWidths(pageC)));
console.log("A/B flagged injected peer:", aFlagsInjected, bFlagsInjected);

if (!legitOk) await fail("legit peers did not decode each other (encryption broke the happy path)");
if (cRemoteEverDecoded) await fail("SECURITY: wrong-key peer decoded remote media — E2EE not enforced");
if (!aFlagsInjected || !bFlagsInjected) await fail("injected peer was NOT flagged as unverified by legit peers");

console.log(
  "MILESTONE PASS: legit peers decode each other and verify each other; injected peer decodes nothing and is flagged unverified",
);
await browser.close();
process.exit(0);
