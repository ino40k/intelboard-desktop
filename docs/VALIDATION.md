# Validation and release acceptance

Development host: Fedora Linux x86-64. The original reference was not modified and its services/data were not used. The user's Windows VM was not accessed; Windows automation ran on a disposable GitHub-hosted Windows 2025 runner.

## Verified locally

- Production TypeScript/Vite build, lazy reader bundle and packaged reader fonts/cmaps/worker.
- Twenty-four automated test cases in eight test files, including formatting/Unicode, reader positions, duplication and preview metadata, GIF frame/timing preservation, safe video URL normalization, future-schema preservation, native title boundaries, transactional board saves, optimistic conflicts and missing-file rollback.
- Portable board/workspace round trips preserve original bytes, coordinates, viewport, groups, edges, formatted labels, media references and reading positions. Repeated imports create separate copies.
- Traversal/unexpected ZIP names, unsupported manifest versions, malformed/forged expansion sizes and inconsistent EPUB metadata are rejected without changing existing boards.
- Native protocol range responses, invalid ranges, inert active-content spoofing and filesystem traversal rejection.
- Metadata restrictions reject private/reserved destinations while local board operations remain usable.
- Hidden/offscreen Electron runtime with sandbox and Node integration disabled: real React board creation, note editing, native Undo/Redo/Select All commands, autosave and persistence across two process launches using disposable synthetic data.
- Runtime with HTTP/HTTPS requests blocked: local image decode, complete board export/import and actual PDF/EPUB rendering. Screenshots inspected for expected canvas and reader layout. EPUB.js attempts to set a base URI are blocked by the retained restrictive CSP; the tested book renders successfully.
- Final Linux AppImage packaging and direct AppImage execution: hidden offline smoke passed across two launches, including the native Edit menu. The embedded ASAR matches the inspected unpacked application byte-for-byte. Extracted launcher metadata has no sandbox-disabling argument.
- Staged-source, production frontend and extracted AppImage-ASAR private-marker audit.
- npm production dependency advisory check: zero known advisories at the time of this build. This is a point-in-time registry check, not a guarantee of no vulnerabilities.

The retained source tests were adapted for the desktop service. The original server's HTTP/login tests and private production browser traces were not imported. New native service/protocol tests cover the replacement boundaries.

## Verified on hosted Windows and Linux

[Build 39911018451](https://github.com/ino40k/intelboard-desktop/actions/runs/39911018451) passed all build jobs for the initial testing release on 2026-10-23.

- Native Windows x64 NSIS installer and Linux x64 AppImage, built on their respective operating systems.
- All 24 automated cases, production build, source runtime and packaged runtime checks on both platforms.
- Windows silent per-user installation, installed application checks across two process launches, and silent uninstallation. Each runtime check uses disposable synthetic data and verifies typing/caret behavior, native canvas Edit commands, persistence, offline image/PDF/EPUB rendering, portable export/import, and resized-region followers across reopening.
- Source, production frontend and packaged ASAR privacy audit on both platforms; native dependency sources and SHA-256 checksums generated separately.

Local tests remain hidden. Hosted Windows checks use the runner's disposable desktop so native selection and rendering have normal window behavior. Initial EPUB location is reconciled after card layout to avoid leaving a rendered chapter labeled "Opening…".

## Not yet verified

- On 2026-10-26, the owner reported that a friend tested the Windows app with good results and approved v1.0.3 as stable. Specific coverage of installer screens, display scaling, native file dialogs and clipboard was not recorded. The Windows installer remains unsigned.
- Manual Fedora desktop acceptance for window decorations, multiple monitors/scaling, native dialogs, drag/drop from the file manager, clipboard integration and AppImage/FUSE behavior remains. Automated hidden rendering is not a substitute for all visible desktop interaction.
- Live YouTube/provider behavior, all video codecs, complex/password-protected/corrupt PDFs and very large EPUBs/boards are not exhaustively tested. Unsupported documents/codecs keep the original-file download fallback.
- No exhaustive crash/power-loss/disk-full campaign or long-running performance benchmark has been performed. Transactions, atomic writes, recovery drafts, prior-start snapshots and error paths were inspected/tested where practical.

## Manual acceptance checklist on each OS

1. Install/launch as an ordinary user with a fresh profile; confirm an empty board library and no server/tool setup.
2. Create a board; add/edit/format notes. Pan/zoom, drag/resize, select/group/layer, connect/label/reverse, search and undo/redo. Test canvas shortcuts and native text clipboard shortcuts.
3. Drop/paste/select a PNG/JPEG/GIF, video, PDF, EPUB and generic file. Read/navigate, add captions, save originals through native dialogs and reopen after restart.
4. Disconnect networking. Edit existing boards and local media; close/reopen. Add an unavailable link and confirm unrelated editing still works.
5. Export a board and a workspace, import each twice on both platforms and compare positions/content/attachment bytes. Cancel dialogs; reject a corrupt export.
6. Close during an unsaved edit and during a capture; verify recovery/dismiss behavior. Relaunch and confirm last board/theme. Install a newer version and confirm data survives.
7. Inspect installer/AppImage contents and exact dependency notices/source availability before public distribution. Confirm no reference environment, trace, private content, history or data file was bundled.

CI repeats source tests, production build, native runtime, packaging, packaged runtime and privacy scan on both platforms, plus Windows installer acceptance. Only an explicitly published GitHub Release triggers installer attachment.

## Persistent connections mode (1.0.3)

The desktop smoke check creates multiple click-to-connect pairs and a dragged-handle connection without reselecting the tool. It verifies that connections mode stays active, Escape cancels a pending source, the C shortcut starts a fresh pair, the toolbar toggle exits, and all four connections retain their endpoints after saving and reopening. This check reproduced the automatic return to Select before the fix. The Windows and Linux release jobs run it against the source and packaged application; Windows also runs it after installation.

## Import work amplification fix (1.0.4)

Import now computes attachment references once and validates each distinct node-referenced EPUB once across all boards. Independent attachment-side validation remains in place, including when node and attachment metadata disagree. Archive format, byte limits, checksums, ID remapping and transactional saves are unchanged.

Three new regression cases bring the suite to 27 tests. On the previous implementation, a small synthetic shared-book archive caused 77 nested ZIP validations instead of 3, and a 96-node archive with 24 attachments caused 2,400 reference visits instead of 96. The patched implementation meets both bounds and preserves the imported references and original bytes. Mixed generic/EPUB metadata in either node order still rejects malformed bytes before adding assets or boards. Existing round-trip, checksum, expansion-limit, reader-position and rollback tests continue to pass.

## Note-caret regression fix

Native character-by-character insertion reproduced the empty-note defect before the fix: after the first character the caret was at offset 0. The editor now keys incoming formatting synchronization by its serialized content, so a local selection render with a fresh but equivalent formatting array cannot reapply stale parent text. Delayed autofocus also preserves an already focused editor’s live caret instead of restoring an outdated initial position. Hidden runtime coverage types a full sentence, checks the caret after every character, clears and retypes text, then verifies the saved result across restarts. The same framework-independent frontend change is supplied in `patches/note-caret.patch` for the web edition; the read-only reference and live web deployment are not changed by the desktop build.

## Resized-region drag regression fix

Region containment now uses measured dimensions, then persisted width/height, before creation-time styles. This matches React Flow's layout and NodeResizer updates. Regression cases cover enlarged/shrunken regions, resized notes, exact edges, overlap rejection and saved dimensions after reopening. The hidden desktop check physically enlarges a region using its resize handle, drags it with two contained notes, then reopens the board and repeats. Both notes must retain their offsets. A matching web-source patch is in `patches/region-drag.patch`; the original reference and live server remain unchanged.
