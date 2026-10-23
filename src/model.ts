import { documentFormat } from '../shared/document.js';
import type { FormatRange } from '../shared/format.js';
import type { Node, Edge, Viewport } from '@xyflow/react';
import { videoMime, youtubeVideo } from '../shared/media.js';
import { uuid } from '../shared/uuid.js';
export type Kind = 'note' | 'link' | 'image' | 'file' | 'region';
export type ItemData = {
  kind: Kind;
  formats?: Partial<Record<'text' | 'title' | 'description' | 'caption', FormatRange[]>>;
  text?: string;
  title?: string;
  url?: string;
  description?: string;
  domain?: string;
  siteName?: string;
  author?: string;
  publishedAt?: string;
  capturedAt?: string;
  capturedTitle?: string;
  captureStatus?: string;
  assetId?: string;
  thumbnailId?: string;
  hidePreview?: boolean;
  reader?: { page?: number; cfi?: string; zoom?: number };
  faviconId?: string;
  filename?: string;
  mime?: string;
  size?: number;
  originalWidth?: number;
  originalHeight?: number;
  caption?: string;
  preview?: string;
  color?: string;
  groupId?: string;
  createdAt?: string;
  updatedAt?: string;
  loading?: boolean;
  localUrl?: string;
  uploadError?: string;
};
export type Item = Node<ItemData, 'research'>;
export type Connection = Edge<{ directed?: boolean; labelFormat?: FormatRange[] }, 'research'>;
export type Board = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  revision: number;
  viewport: Viewport;
  nodes: Item[];
  edges: Connection[];
  count?: number;
};
export type Asset = {
  id: string;
  filename: string;
  mime: string;
  size: number;
  thumbnail?: string;
  width?: number;
  height?: number;
  preview?: string;
};
export { uuid } from '../shared/uuid.js';
export const assetUrl = (id: string, preview = true) =>
  `/api/assets/${id}?${preview ? 'preview=1' : 'inline=1'}`;
export const downloadUrl = (id: string) => `/api/assets/${id}`;
export const readableSize = (size = 0) =>
  size < 1024
    ? `${size} B`
    : size < 1048576
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1048576).toFixed(1)} MB`;
export function makeItem(
  kind: Kind,
  position: { x: number; y: number },
  data: Partial<ItemData> = {},
): Item {
  const sizes = {
    note: [280, 220],
    link: [300, 290],
    image: [320, 240],
    file: [290, 200],
    region: [720, 480],
  };
  const isVideo =
    (kind === 'file' && videoMime(data.filename, data.mime)) ||
    (kind === 'link' && youtubeVideo(data.url));
  const [width, height] = isVideo
    ? [420, 300]
    : kind === 'file' && documentFormat(data.filename, data.mime)
      ? [480, 560]
      : sizes[kind];
  return {
    id: uuid(),
    type: 'research',
    position,
    style: { width, height },
    zIndex: kind === 'region' ? -100 : 1,
    data: {
      kind,
      color: kind === 'note' ? 'amber' : 'neutral',
      createdAt: new Date().toISOString(),
      ...data,
    },
  };
}
export function cleanNodes(nodes: Item[]): Item[] {
  return nodes.map(({ id, type, position, data, style, width, height, zIndex }) => {
    const { loading, localUrl, uploadError, ...saved } = data;
    return {
      id,
      type,
      position,
      data: Object.fromEntries(
        Object.entries(saved).filter(([, value]) => value != null),
      ) as unknown as ItemData,
      style,
      width,
      height,
      zIndex,
    };
  });
}
export function cleanEdges(edges: Connection[]): Connection[] {
  return edges.map(({ id, source, target, sourceHandle, targetHandle, type, label, data }) => ({
    id,
    source,
    target,
    sourceHandle,
    targetHandle,
    type,
    label,
    data,
  }));
}
export const searchable = (n: Item) =>
  Object.entries(n.data)
    .filter(
      ([k, v]) =>
        !['assetId', 'thumbnailId', 'faviconId', 'localUrl', 'groupId'].includes(k) &&
        typeof v === 'string',
    )
    .map(([, v]) => v)
    .join(' ')
    .toLowerCase();
export function duplicateItems(nodes: Item[], edges: Connection[], offset = 32) {
  const selected = nodes.filter((n) => n.selected);
  const ids = new Map(selected.map((n) => [n.id, uuid()]));
  const groups = new Map(
    selected.filter((n) => n.data.groupId).map((n) => [n.data.groupId!, uuid()]),
  );
  return {
    nodes: selected.map((n) => ({
      ...n,
      id: ids.get(n.id)!,
      position: { x: n.position.x + offset, y: n.position.y + offset },
      selected: true,
      data: { ...n.data, groupId: n.data.groupId ? groups.get(n.data.groupId) : undefined },
    })),
    edges: edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ ...e, id: uuid(), source: ids.get(e.source)!, target: ids.get(e.target)! })),
  };
}
