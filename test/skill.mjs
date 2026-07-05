// The SKILL: the menu-bar "Skill" action composes an agent brief for operating
// this circle — the system preamble, every installed app's skill section, and
// the invite link (whose fragment carries the secret) — and copies it to the
// clipboard. This asserts the composed doc round-trips to the clipboard with
// all of it present.
//   CIRCLE_URL=http://localhost:8788 node test/skill.mjs
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

const require = createRequire(import.meta.url);
const pw = process.env.PLAYWRIGHT_CORE ?? "/Users/clawd/clawd-harness/tools/node_modules/playwright-core/index.mjs";
const { chromium } = await import(existsSync(pw) ? pw : require.resolve("playwright-core"));

const BASE = process.env.CIRCLE_URL ?? "http://localhost:8788";
const SECRET = "secret123";
const URL = `${BASE}/#room${Date.now().toString(36)}:${SECRET}`;

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

const ctx = await browser.newContext();
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
const p = await ctx.newPage();
await p.goto(URL);
await p.waitForSelector("text=doesn't exist yet", { timeout: 6000 }).catch(() => fail("no claim offer"));
await p.click("text=Create room");
await p.waitForSelector(".slop-menubar", { timeout: 6000 }).catch(() => fail("not admitted"));

await p.getByRole("button", { name: "Skill", exact: true }).click();
await p.waitForSelector("text=Copied ✓", { timeout: 4000 }).catch(() => fail("Skill button never confirmed copy"));

const doc = await p.evaluate(() => navigator.clipboard.readText());

const must = [
  "# Operating this circle", // system preamble
  "end-to-end", // the privacy framing
  URL, // the invite link (secret in the fragment)
  "**Notes**", // each installed app's skill section
  "**Chat**",
  "**Wallet**",
  "shared room notepad", // an app's actual skill text
];
for (const needle of must) {
  if (!doc.includes(needle)) await fail(`skill doc missing: ${JSON.stringify(needle)}`);
}
// The relay must never see the secret: it lives only past the '#'.
if (!doc.includes(`#room`) || !doc.includes(`:${SECRET}`)) await fail("invite link lost its fragment secret");

console.log("MILESTONE PASS: SKILL composes system + per-app briefs + invite link and copies to clipboard");
await browser.close();
process.exit(0);
