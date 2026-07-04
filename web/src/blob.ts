import { decryptBus, encryptBus } from "./crypto/busCrypto";

// Durable per-room state via the relay's encrypted blob store. The relay only
// ever sees AES-GCM ciphertext (keyed from the room secret), so it can hold
// state for peer-authority apps without being able to read it. This is what
// makes an app like Notes durable + late-join-able with zero server logic.

export async function putBlob(slug: string, key: string, obj: unknown, roomKey: ArrayBuffer): Promise<void> {
  const data = await encryptBus(obj, roomKey);
  await fetch(`/v1/rooms/${encodeURIComponent(slug)}/blob/${encodeURIComponent(key)}`, {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data }),
  });
}

export async function getBlob<T>(slug: string, key: string, roomKey: ArrayBuffer): Promise<T | null> {
  const res = await fetch(`/v1/rooms/${encodeURIComponent(slug)}/blob/${encodeURIComponent(key)}`, {
    credentials: "include",
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { data?: string } | null;
  if (!body?.data) return null;
  return decryptBus<T>(body.data, roomKey);
}
