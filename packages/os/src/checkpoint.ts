// Portable, operator-independent room state — the §5 censorship-resistance
// primitive. Because the relay stores only ciphertext, a member can export the
// entire encrypted room and re-import it into ANY Commons relay (or the same
// one after a wipe): the operator can neither lock a circle in nor delete it
// out of existence. Restore into the same slug with the same secret and it
// decrypts as before. IPFS pinning / on-chain anchoring of the archive's
// contentHash is the next layer up (the hash is the anchor value).

export type RoomArchive = {
  v: 1;
  slug: string;
  exportedAt: number;
  /** SHA-256 of the canonical blob set — an integrity check + the value an
   *  IPFS/on-chain anchor would commit to. */
  contentHash: string;
  /** key → opaque ciphertext (exactly as the relay stores it). */
  blobs: Record<string, string>;
};

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function listBlobKeys(slug: string): Promise<string[]> {
  const res = await fetch(`/v1/rooms/${encodeURIComponent(slug)}/blobs`, { credentials: "include" });
  if (!res.ok) return [];
  return ((await res.json()) as { keys?: string[] }).keys ?? [];
}

/** Snapshot every encrypted blob in a room into a portable archive. */
export async function exportRoom(slug: string): Promise<RoomArchive> {
  const keys = await listBlobKeys(slug);
  const blobs: Record<string, string> = {};
  for (const key of keys.sort()) {
    const res = await fetch(`/v1/rooms/${encodeURIComponent(slug)}/blob/${encodeURIComponent(key)}`, { credentials: "include" });
    if (res.ok) blobs[key] = ((await res.json()) as { data?: string }).data ?? "";
  }
  const contentHash = await sha256Hex(JSON.stringify(blobs));
  return { v: 1, slug, exportedAt: Date.now(), contentHash, blobs };
}

/** Restore an archive's blobs into a room (must already be authed for it). */
export async function importRoom(targetSlug: string, archive: RoomArchive): Promise<{ imported: number; total: number }> {
  const entries = Object.entries(archive.blobs);
  let imported = 0;
  for (const [key, data] of entries) {
    const res = await fetch(`/v1/rooms/${encodeURIComponent(targetSlug)}/blob/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ data }),
    });
    if (res.ok) imported++;
  }
  return { imported, total: entries.length };
}
