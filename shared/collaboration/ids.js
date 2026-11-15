import { digest } from "lib0/hash/sha256";
export function collaborationId(actor, nonce, session) {
  const bytes = digest(
    new TextEncoder().encode(actor + ":" + session + ":" + nonce),
  );
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const s = [...bytes.subarray(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
