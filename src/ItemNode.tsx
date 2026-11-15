import { lazy, Suspense, memo, useContext, createContext } from "react";
import { InlineEditor, InlineText } from "./InlineText";
import {
  Handle,
  Position,
  NodeResizer,
  type NodeProps,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";
import {
  ArrowUpRight,
  FileText,
  Globe,
  Image as ImageIcon,
  LoaderCircle,
  Paperclip,
} from "lucide-react";
import {
  assetUrl,
  downloadUrl,
  readableSize,
  type Item,
  type ItemData,
} from "./model";
import { videoMime, youtubeVideo } from "../shared/media.js";
import { VideoPresentation } from "./VideoPresentation";
import { GifPresentation } from "./GifPresentation";
import { documentFormat } from "../shared/document.js";
import type { SharedBoardController } from "./collaboration/controller";
import { NodePresence, useCollaborationStatus } from "./collaboration/Controls";
const DocumentReader = lazy(() => import("./DocumentReader"));
export const CanvasContext = createContext<{
  editing: string | null;
  edit: (id: string | null) => void;
  update: (id: string, data: Partial<ItemData>) => void;
  checkpoint: () => void;
  manipulate: (active: boolean) => void;
  view: (id: string) => void;
  query: string;
  connectMode: boolean;
  editEdge: (id: string) => void;
  collaboration?: SharedBoardController | null;
}>({
  editing: null,
  edit: () => {},
  update: () => {},
  checkpoint: () => {},
  manipulate: () => {},
  view: () => {},
  query: "",
  connectMode: false,
  editEdge: () => {},
});
export const ItemNode = memo(function ItemNode({
  id,
  data,
  selected,
}: NodeProps<Item>) {
  const ctx = useContext(CanvasContext),
    editing = ctx.editing === id;
  const collaborationStatus = useCollaborationStatus(ctx.collaboration);
  const declaredAsset = ctx.collaboration?.doc
    .getMap<any>("nodes")
    .get(id)
    ?.get("data")
    .get("assetId");
  const downloading =
    !!ctx.collaboration &&
    ["image", "file"].includes(data.kind) &&
    !data.localUrl &&
    !!declaredAsset &&
    !collaborationStatus?.availableAssets?.includes(declaredAsset);
  const available = (assetId?: string) =>
    !ctx.collaboration ||
    (!!assetId && collaborationStatus?.availableAssets?.includes(assetId));
  const isVideo =
    (data.kind === "file" && !!videoMime(data.filename, data.mime)) ||
    (data.kind === "link" && !!youtubeVideo(data.url));
  const isDocument =
    data.kind === "file" && !!documentFormat(data.filename, data.mime);
  const imageSrc =
    data.localUrl || (data.assetId ? assetUrl(data.assetId) : "");
  return (
    <div
      className={`item ${isDocument ? "item-document" : ""} item-${data.kind} tone-${data.color || "neutral"} ${selected ? "is-selected" : ""} ${isVideo ? "item-video" : ""} ${data.kind === "link" && data.hidePreview && !isVideo ? "link-text-only" : ""}`}
      data-kind={data.kind}
    >
      <NodePresence controller={ctx.collaboration} id={id} />
      <NodeResizer
        isVisible={selected && !editing && !ctx.collaboration?.locked(id)}
        minWidth={
          data.kind === "region" ? 240 : isVideo || isDocument ? 240 : 180
        }
        minHeight={
          data.kind === "region" ? 160 : isVideo ? 252 : isDocument ? 200 : 100
        }
        keepAspectRatio={data.kind === "image"}
        shouldResize={() => !ctx.collaboration?.locked(id)}
        onResizeStart={() => {
          if (ctx.collaboration?.locked(id)) return;
          ctx.collaboration?.presence({ resize: id });
          ctx.checkpoint();
          ctx.manipulate(true);
        }}
        onResizeEnd={() => {
          ctx.manipulate(false);
          ctx.collaboration?.presence({ resize: null });
        }}
      />
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: "none" }}
        aria-hidden="true"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        title="Drag to connect items"
        aria-label="Drag to connect items"
      />
      {/* Retain the first target (in) and source (out) for legacy edges without
          handle IDs. Loose mode still requires sources for outgoing endpoints;
          the visible left source shares the legacy target's position and ID. */}
      <Handle
        type="source"
        position={Position.Left}
        id="in"
        title="Drag to connect items"
        aria-label="Left connection handle"
      />
      <Handle
        type="source"
        position={Position.Top}
        id="top"
        title="Drag to connect items"
        aria-label="Top connection handle"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="bottom"
        title="Drag to connect items"
        aria-label="Bottom connection handle"
      />
      {data.kind === "note" && (
        <>
          <div
            className="note-eyebrow"
            style={editing ? { visibility: "hidden" } : undefined}
          >
            NOTE
          </div>
          {editing ? (
            <InlineEditor
              className="note-editor"
              binding={ctx.collaboration?.binding(id)}
              autoFocus
              label="Note text"
              value={data.text}
              format={data.formats?.text}
              maxLength={200000}
              placeholder="Start writing…"
              onChange={(text, format) =>
                ctx.update(id, {
                  text,
                  formats: { ...data.formats, text: format },
                })
              }
              onBlur={() => ctx.edit(null)}
              onDone={() => ctx.edit(null)}
            />
          ) : (
            <div className="note-content">
              {data.text ? (
                <InlineText text={data.text} format={data.formats?.text} />
              ) : (
                <span className="placeholder">Double-click to write…</span>
              )}
            </div>
          )}
          <div className="note-foot">
            <span />
            {data.groupId && "Grouped"}
          </div>
        </>
      )}
      {data.kind === "region" && (
        <>
          {editing ? (
            <InlineEditor
              className="region-editor"
              binding={ctx.collaboration?.binding(id, "title")}
              autoFocus
              multiline={false}
              label="Region title"
              value={data.title}
              format={data.formats?.title}
              maxLength={4000}
              placeholder="Name this region"
              onChange={(title, format) =>
                ctx.update(id, {
                  title,
                  formats: { ...data.formats, title: format },
                })
              }
              onBlur={() => ctx.edit(null)}
              onDone={() => ctx.edit(null)}
            />
          ) : (
            <div className="region-heading">
              <span className="region-dot" />
              <span>
                <InlineText
                  text={data.title || "Untitled region"}
                  format={data.formats?.title}
                />
              </span>
            </div>
          )}
        </>
      )}
      {downloading && (
        <div className="shared-asset-pending" role="status">
          <LoaderCircle className="spin" size={22} />
          <strong>{data.filename || "Attachment"}</strong>
          <span>Downloading to this device…</span>
        </div>
      )}
      {isVideo && !downloading && <VideoPresentation data={data} />}
      {data.kind === "link" && !isVideo && (
        <>
          {!data.hidePreview &&
            (data.thumbnailId && available(data.thumbnailId) ? (
              <img
                className="link-preview"
                loading="lazy"
                src={assetUrl(data.thumbnailId)}
                alt=""
                draggable={false}
              />
            ) : (
              <div className="link-no-preview">
                <Globe size={30} strokeWidth={1} />
                <span>{data.domain || "WEB SOURCE"}</span>
              </div>
            ))}
          <div className="link-body">
            <div className="source-line">
              {data.faviconId && available(data.faviconId) && (
                <img src={assetUrl(data.faviconId)} alt="" />
              )}
              <span>{data.siteName || data.domain || "Web source"}</span>
              {data.loading && <LoaderCircle className="spin" size={13} />}
            </div>
            <div className="link-title">
              <InlineText
                text={data.title || data.url}
                format={data.formats?.title}
              />
            </div>
            <p className="link-description">
              <InlineText
                text={
                  data.description ||
                  (data.loading
                    ? "Capturing source details…"
                    : "Original link preserved. Add context in Edit.")
                }
                format={data.formats?.description}
              />
            </p>
            <div className="source-footer">
              <span>
                {data.author ||
                  (data.publishedAt
                    ? data.publishedAt.slice(0, 10)
                    : data.capturedAt
                      ? "Captured " +
                        new Date(data.capturedAt).toLocaleDateString(
                          undefined,
                          {
                            month: "short",
                            day: "numeric",
                          },
                        )
                      : "Source link")}
              </span>
              <a
                className="nodrag icon-link"
                href={data.url}
                target="_blank"
                rel="noopener noreferrer"
                title="Open original source"
                aria-label="Open original source"
              >
                <ArrowUpRight size={16} />
              </a>
            </div>
          </div>
        </>
      )}
      {data.kind === "image" && !downloading && (
        <>
          <div className="image-surface">
            {data.mime === "image/gif" && imageSrc ? (
              <GifPresentation data={data} />
            ) : imageSrc ? (
              <img
                loading="lazy"
                src={imageSrc}
                alt={data.caption || data.filename || "Research image"}
                draggable={false}
              />
            ) : (
              <ImageIcon size={32} />
            )}
          </div>
          {data.loading && (
            <div className="upload-state">
              <LoaderCircle size={14} className="spin" />
              Uploading…
            </div>
          )}
          {data.uploadError && (
            <div className="upload-state error">{data.uploadError}</div>
          )}
          <div className="image-caption">
            <span title={data.filename || "Image"}>
              {data.filename || "Image"}
            </span>
            <ImageIcon size={13} />
          </div>
          {data.caption && (
            <p
              className="media-notes nodrag nopan nowheel"
              aria-label="Notes / caption"
            >
              <InlineText text={data.caption} format={data.formats?.caption} />
            </p>
          )}
        </>
      )}
      {isDocument && !downloading && (
        <Suspense
          fallback={<div className="reader-message">Loading reader…</div>}
        >
          <DocumentReader
            data={data}
            onChange={(reader) => ctx.update(id, { reader })}
            checkpoint={ctx.checkpoint}
          />
        </Suspense>
      )}
      {data.kind === "file" && !isVideo && !isDocument && !downloading && (
        <>
          <div className="file-heading">
            <div className="file-icon">
              <FileText size={26} strokeWidth={1.4} />
            </div>
            <span className="file-type">
              {data.filename?.split(".").pop()?.toUpperCase() || "FILE"}
            </span>
            {data.loading && <LoaderCircle size={15} className="spin" />}
          </div>
          <strong className="filename" title={data.filename}>
            {data.filename || "Uploading file…"}
          </strong>
          <div className="file-size">
            {readableSize(data.size)} · Original file
          </div>
          {data.preview && <pre className="file-preview">{data.preview}</pre>}
          {data.caption && (
            <p
              className="file-caption media-notes nodrag nopan nowheel"
              aria-label="Notes / caption"
            >
              <InlineText text={data.caption} format={data.formats?.caption} />
            </p>
          )}
          <div className="file-footer">
            <span>{data.uploadError || "ATTACHMENT"}</span>
            {data.assetId && (
              <a
                href={downloadUrl(data.assetId)}
                className="nodrag icon-link"
                title="Download original file"
                aria-label="Download original file"
              >
                <Paperclip size={15} />
              </a>
            )}
          </div>
        </>
      )}
    </div>
  );
});
export function ResearchEdge(props: EdgeProps) {
  const ctx = useContext(CanvasContext);
  const [path, x, y] = getBezierPath(props);
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        interactionWidth={22}
        style={{
          stroke: props.selected ? "var(--accent)" : "var(--wire)",
          strokeWidth: props.selected ? 2 : 1.5,
        }}
        markerEnd={props.data?.directed ? "url(#arrow)" : undefined}
      />
      <EdgeLabelRenderer>
        {(props.label || props.selected) && (
          <button
            className={`edge-label nodrag nopan ${props.selected ? "selected" : ""}`}
            style={{
              transform: `translate(-50%, -50%) translate(${x}px,${y}px)`,
            }}
            onDoubleClick={() => ctx.editEdge(props.id)}
            onClick={() => ctx.editEdge(props.id)}
            title="Edit connection label"
          >
            <InlineText
              text={String(props.label || "Add label")}
              format={
                props.data?.labelFormat as
                  import("./InlineText").FormatRange[] | undefined
              }
            />
          </button>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
