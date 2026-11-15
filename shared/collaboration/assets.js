import { z } from "zod";
export function assetIdForHash(hash) {
  const h = hash.slice(0, 32).split("");
  h[12] = "5";
  h[16] = "89ab"[Number.parseInt(h[16], 16) % 4];
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
export const manifestSchema = z
  .object({
    id: z.string().uuid(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    size: z
      .number()
      .int()
      .min(1)
      .max(50 * 1024 * 1024),
    filename: z
      .string()
      .min(1)
      .max(4000)
      .refine((s) => !/[\\/\x00]/.test(s)),
    mime: z.string().max(200),
  })
  .strict()
  .refine(
    (m) => m.id === assetIdForHash(m.hash),
    "Invalid content-addressed attachment ID",
  );
