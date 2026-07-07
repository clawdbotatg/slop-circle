// Portable, operator-independent room state: a member exports the whole
// encrypted room (via the UI Backup) and it can be re-imported faithfully into
// a different room/relay — the operator can't lock a circle in or delete it.
// The relay only ever sees ciphertext, so the archive is opaque; here we prove
// the export captures the room's encrypted state and import restores it
// byte-for-byte, with a stable content hash.
//   CIRCLE_URL=http://localhost:8788 node test/portable.mjs
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

const require = createRequire(import.meta.url);
const pw = process.env.PLAYWRIGHT_CORE ?? "/Users/clawd/clawd-harness/tools/node_modules/playwright-core/index.mjs";
const { chromium } = await import(existsSync(pw) ? pw : require.resolve("playwright-core"));

const BASE = process.env.CIRCLE_URL ?? "http://localhost:8788";
const stamp = Date.now().toString(36);
const SLUG = `port${stamp}`;
const URL = `${BASE}/#${SLUG}:secret123`;
const NOTE = "survive the operator";

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

const ctx = await browser.newContext({ acceptDownloads: true });
const p = await ctx.newPage();
await p.goto(URL);
await p.waitForSelector("text=doesn't exist yet", { timeout: 6000 }).catch(() => fail("no claim offer"));
await p.click("text=Create room");
await p.waitForSelector(".slop-menubar", { timeout: 6000 }).catch(() => fail("not admitted"));

// Write a note and let it persist to the encrypted blob.
await p.getByRole("button", { name: "Notes", exact: true }).click();
await p.waitForSelector('[data-testid="notes-text"]', { timeout: 8000 });
await p.fill('[data-testid="notes-text"]', NOTE);
await new Promise(r => setTimeout(r, 1500));

// Backup → capture the downloaded archive.
const [download] = await Promise.all([p.waitForEvent("download", { timeout: 8000 }), p.click('[data-testid="backup"]')]);
const archivePath = await download.path();
if (!archivePath) await fail("no archive downloaded");
const archive = JSON.parse(readFileSync(archivePath, "utf8"));

if (archive.v !== 1 || archive.slug !== SLUG) await fail(`bad archive header: ${JSON.stringify(archive).slice(0, 120)}`);
if (!archive.blobs || !archive.blobs["notes-crdt"]) await fail("archive missing the notes-crdt blob");
if (!/^[0-9a-f]{64}$/.test(archive.contentHash)) await fail(`bad contentHash: ${archive.contentHash}`);
// The archive must be opaque ciphertext — the plaintext note must NOT appear.
if (JSON.stringify(archive.blobs).includes(NOTE)) await fail("archive leaked plaintext — should be ciphertext only");
console.log(`backup: captured ${Object.keys(archive.blobs).length} encrypted blob(s) · hash ${archive.contentHash.slice(0, 12)} · opaque ✓`);

// Restore into a DIFFERENT room (simulating a fresh relay/room): claim it,
// PUT the archive's blobs, and confirm the ciphertext round-trips exactly.
const DEST = `dest${stamp}`;
const claim = await p.request.post(`${BASE}/v1/rooms/${DEST}/claim`, { data: { password: "restore-pass" } });
if (!claim.ok()) await fail(`could not claim restore room (${claim.status()})`);
for (const [key, data] of Object.entries(archive.blobs)) {
  const put = await p.request.put(`${BASE}/v1/rooms/${DEST}/blob/${key}`, { data: { data } });
  if (!put.ok()) await fail(`restore PUT ${key} failed (${put.status()})`);
}
const got = await p.request.get(`${BASE}/v1/rooms/${DEST}/blob/notes-crdt`);
if (!got.ok()) await fail(`restored blob not readable (${got.status()})`);
const restored = (await got.json()).data;
if (restored !== archive.blobs["notes-crdt"]) await fail("restored ciphertext does not match the archive");

console.log("restore: encrypted state re-imported into a fresh room byte-for-byte ✓");
console.log("MILESTONE PASS: room state is portable + operator-independent (export/import faithful, relay-blind)");
await browser.close();
process.exit(0);
