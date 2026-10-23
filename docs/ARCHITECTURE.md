# Architecture and feature inventory

The supplied reference was an extracted source directory; no ZIP was present in the workspace or attachments. It was inspected in place and remains unchanged. Its Git history, configuration and runtime artifacts were not imported.

## Original architecture

React 19 + TypeScript + Vite builds the interface. React Flow provides nodes, edges, viewport interaction, selection, resize handles and minimap. Local component state implements undo/redo, grouping, clipboard formats and transient capture/upload placeholders. Formatted text uses validated UTF-16 ranges and plain-text rendering. Five persisted item kinds are note, link, image, file and region. File presentation derives video/PDF/EPUB behavior from metadata, without adding new persisted item kinds.

Express supplied board CRUD/duplication, revision-controlled saves, uploads, downloads/ranges, metadata capture and authentication. Node's embedded SQLite stored normalized boards/elements/connections/assets/reference tables; originals/previews lived in an assets folder. There was no separate database server. Password setup/login used bcrypt, cookies and a sessions table; environment variables and reverse proxy settings supported the private server. Sharp decodes raster images; custom helpers normalize GIF loop behavior and detect video containers. Metadata capture resolves and pins public addresses, rechecks redirects and limits time/bytes. EPUB.js and PDF.js power lazy-loaded readers.

## Desktop choices

Electron preserves Chromium rendering behavior and directly runs the existing JavaScript/Node SQLite/Sharp modules. This avoids introducing a Rust backend and rewriting otherwise compatible functionality. The production frontend is loaded from a secure, standard `intelboard:` protocol, not a development server. No Express dependency or listening network socket remains.

- `src/`: existing canvas, card/editor/reader components, styles and themes; desktop API adapter.
- `shared/`: original schemas and media, document, formatting and UUID helpers.
- `desktop/main.js`: lifecycle, user-data location, native dialogs/menu/window bounds, IPC sender checks.
- `desktop/service.js`: bounded, validated operations and online capture.
- `desktop/store.js`: embedded SQLite, references, transactions, revisions and duplication.
- `desktop/assets.js`: local originals/previews, image and video detection.
- `desktop/protocol.js`: read-only packaged-resource and asset streaming, byte ranges, CSP.
- `desktop/transfer.js`, `zip.js`: versioned complete board archives and bounded streaming validation.
- `tests/`, `scripts/`, `.github/workflows/`: repeatable validation, packaging and release preparation.

## Feature parity from code

| Source feature | Desktop implementation |
| --- | --- |
| Library: create, open, rename, delete, duplicate, search, last board | Retained; fresh empty per-user workspace |
| Position/resize, pan/zoom, fit, multiselect, layering | Existing React Flow canvas retained |
| Regions, group/ungroup and drag followers | Retained; whole-board duplication now remaps group IDs |
| Notes and text formatting | Existing plain-text/range editor retained |
| Connections, four handles, arrows and formatted labels | Retained |
| Clipboard nodes/text/files, undo/redo, shortcuts | Retained; native Edit menu for text clipboard |
| Image thumbnails, viewer, caption and original | Retained; native Save As for originals |
| GIF animation and reduced-motion handling | Retained |
| Browser-supported video containers and YouTube | Retained; native range streaming and isolated remote frame |
| PDF pages/zoom and EPUB chapters/CFI | Retained; native bounded EPUB validation added |
| Item inspector, notes, colors, metadata retry, preview visibility | Retained |
| Search/jump, minimap and themes | Retained |
| Upload/paste/drop files and failure placeholders | Retained; 50 MB per file |
| Autosave, optimistic revisions and recovery drafts | Retained; local IPC and synchronous close flush |
| Online metadata, cached preview/favicon and source HTML | Retained with public-address restrictions; graceful failure |
| Remote login, setup, sessions, proxy/deployment controls | Removed; operating-system account owns local data |
| Complete board/workspace transfer | Added through native dialogs |

## Storage and transfer contracts

SQLite writes update all board rows and asset references in one immediate transaction, with foreign keys and revision validation. A failed update rolls back. Fresh databases contain no authentication/session tables and no personal/default boards. Existing data is never reset on startup. Unknown future schema versions must be rejected before migration. Original files are UUID-named and atomically committed before database registration. The previous-start database snapshot and Chromium drafts provide additional recovery paths; neither replaces backups.

`.intelboard` v1 is an uncompressed ZIP with `manifest.json` and `assets/<uuid>` payloads. The manifest contains validated board content, coordinates, viewport, relationships, reading positions, formatted text and SHA-256 checksums. No original-computer filesystem paths are needed. Thumbnail source assets are included and previews are regenerated locally. Boards/node/edge/group/asset IDs are reassigned on import. Multiple boards are imported in a single database transaction. Files added before a failed transaction are removed when possible; a process crash may leave unused files, never partially imported boards.

Limits: 50 MB per original/entry, 32 MB manifest, 512 MB total archive/expanded data, 1,000 boards, 10,000 attachments; existing schema permits 5,000 items and 10,000 connections per board. Archives are bounded in memory; they are not intended for multi-gigabyte workspace backups. The reader preflight separately caps EPUB expansion at 100 MB and 5,000 entries. Streaming decompression counts actual output, rejects size mismatches, encryption, unsafe/duplicate names and excess entries. No archive path is extracted. Incompatible versions fail without changing boards. Preferences and unused files are deliberately outside portable workspace exports.

## Security boundaries

Renderer Node integration is disabled, context isolation and Chromium sandbox are enabled, web security remains enabled. Only the app's exact main frame may invoke a small IPC operation allowlist; no arbitrary native path or shell API is exposed. Permissions and webviews are denied. Navigation/popup handlers permit only HTTP(S) external links to the system browser. Attachment originals are served as inert bytes unless validated raster/video; HTML/SVG are not executed. EPUB content retains sanitization, script-disabled frames and restrictive CSP. The app denies online frame access to its custom resource protocol. No analytics, telemetry, accounts, auto-launch or background service is added.

## Known practical differences

No password prompt or multi-user server access; local data relies on operating-system permissions and is not encrypted. Sharing is portable file transfer. Source sites and YouTube can impose network/provider limitations. Media codec support depends on Chromium/platform; unsupported originals remain downloadable. Native OS dialogs/menu and desktop transfer controls supplement the original styling. Window width has an 800 px minimum. Future upgrades require explicit, additive schema migrations; no automatic update service exists.
