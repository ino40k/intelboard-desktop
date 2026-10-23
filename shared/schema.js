import { z } from 'zod';
const id = z.string().uuid(),
  finite = z.number().finite();
const format = z
  .array(
    z
      .object({
        start: z.number().int().min(0).max(200000),
        end: z.number().int().min(1).max(200000),
        style: z.number().int().min(1).max(7),
      })
      .refine((r) => r.end > r.start, 'Invalid formatting range'),
  )
  .max(10000);
const formats = z.object({
  text: format.optional(),
  title: format.optional(),
  description: format.optional(),
  caption: format.optional(),
});
const data = z.object({
  formats: formats.optional(),
  kind: z.enum(['note', 'link', 'image', 'file', 'region']),
  text: z.string().max(200000).optional(),
  title: z.string().max(4000).optional(),
  url: z
    .url()
    .max(8000)
    .refine((value) => /^https?:\/\//i.test(value), 'Links must use HTTP or HTTPS')
    .optional(),
  description: z.string().max(10000).optional(),
  domain: z.string().max(1000).optional(),
  siteName: z.string().max(4000).optional(),
  author: z.string().max(4000).optional(),
  publishedAt: z.string().max(4000).optional(),
  capturedAt: z.string().max(200).optional(),
  capturedTitle: z.string().max(4000).optional(),
  captureStatus: z.string().max(4000).optional(),
  assetId: id.optional(),
  thumbnailId: id.optional(),
  hidePreview: z.boolean().optional(),
  reader: z
    .object({
      page: z.number().int().min(1).max(1000000).optional(),
      cfi: z
        .string()
        .max(8000)
        .regex(/^epubcfi\(.+\)$/)
        .optional(),
      zoom: z.number().min(0.5).max(3).optional(),
    })
    .optional(),
  faviconId: id.optional(),
  filename: z.string().max(4000).optional(),
  mime: z.string().max(200).optional(),
  size: finite.nonnegative().optional(),
  originalWidth: finite.optional(),
  originalHeight: finite.optional(),
  caption: z.string().max(10000).optional(),
  preview: z.string().max(10000).optional(),
  color: z.enum(['neutral', 'amber', 'blue', 'green', 'rose']).optional(),
  groupId: id.optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
const node = z.object({
  id,
  type: z.literal('research'),
  position: z.object({ x: finite, y: finite }),
  data,
  width: finite.min(40).max(20000).optional(),
  height: finite.min(30).max(20000).optional(),
  style: z
    .object({
      width: finite.min(40).max(20000).optional(),
      height: finite.min(30).max(20000).optional(),
    })
    .optional(),
  zIndex: finite.min(-10000).max(10000).optional(),
});
const edge = z.object({
  id,
  source: id,
  target: id,
  sourceHandle: z.string().max(100).nullable().optional(),
  targetHandle: z.string().max(100).nullable().optional(),
  type: z.literal('research').optional(),
  label: z.string().max(1000).optional(),
  data: z.object({ directed: z.boolean().optional(), labelFormat: format.optional() }).optional(),
});
const boardSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    revision: z.number().int().nonnegative(),
    viewport: z.object({ x: finite, y: finite, zoom: finite.min(0.05).max(4) }),
    nodes: z.array(node).max(5000),
    edges: z.array(edge).max(10000),
  })
  .superRefine((b, ctx) => {
    const ids = new Set(b.nodes.map((n) => n.id));
    if (ids.size !== b.nodes.length || new Set(b.edges.map((e) => e.id)).size !== b.edges.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate element or connection identifier' });
    if (b.edges.some((e) => !ids.has(e.source) || !ids.has(e.target)))
      ctx.addIssue({ code: 'custom', message: 'Connection references a missing element' });
    for (const n of b.nodes)
      if (n.data.url) {
        try {
          if (!['https:', 'http:'].includes(new URL(n.data.url).protocol)) throw 0;
        } catch {
          ctx.addIssue({ code: 'custom', message: 'Links must use HTTP or HTTPS' });
        }
      }
  });

export { node as nodeSchema, edge as edgeSchema, boardSchema };
