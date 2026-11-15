# Canvas navigation and alignment

These changes are included in the 1.1.0-dev.2 desktop preview, following the
1.1.0-dev.1 collaboration preview. Stable 1.0.4 remains available separately.

- Hold the right mouse button and drag to pan, including over notes, images,
  regions, active editors, resize/connection handles and document/player surfaces.
- Hold the right button and scroll up/down to zoom in/out around the pointer.
  Normal scrolling, Ctrl/Meta scrolling, trackpad pinch and existing zoom controls
  retain their behavior and the 5%–400% limits.
- Connection handles retain their normal visibility rules. Their visible circle
  and pointer target grow continuously by `clamp(1 / zoom, 1, 3)` below 100% zoom.
  The 9px measured anchor stays fixed, preserving legacy handles and edge paths.
- Nearby left/center/right and top/center/bottom anchors snap within six screen
  pixels. A nine-pixel release threshold avoids jitter. Temporary accent-colored
  dashed guides disappear when the drag ends. Free movement is unchanged outside
  those bands; there is no new global grid.

Snapping treats selected nodes, group members and initial region contents as one
rigid formation. Only that formation moves. Stationary containing regions are
excluded as magnetic backgrounds. Candidate anchors are sorted once at drag
start and queried in narrow coordinate bands; references must also be within 96
screen pixels on the other axis. Native drag updates pass through React Flow's
normal change handling, autosave and private/shared Undo/Redo. Drag previews remain
ephemeral on shared boards and commit through the existing collaboration model.

Right navigation uses capture listeners and pointer capture before child handlers,
coalesces viewport updates with animation frames, and releases on mouse-up, lost
capture, cancellation, app blur and hidden/unmounted views. It does not select,
edit, resize, connect or move cards. Context-menu suppression applies after a
navigation gesture; a stationary right click retains existing handling.

EPUB pages have separate same-origin documents, so their capture listeners are
registered and removed as those frames load. Isolated YouTube players receive a
small trusted application listener after loading. It forwards only right-button
gesture coordinates to the parent; the parent validates the sender iframe, exact
origin, message type and numeric bounds. It exposes no native APIs, board data or
filesystem access, changes no CSP/sandbox settings, and leaves ordinary player
input alone. The iframe test uses a synthetic intercepted HTTPS player, not a
real video or personal board.

Validation commands:

```sh
npm test
npm run build
npm run test:canvas
npm run test:canvas:shared
npm run test:desktop
npm run test:collaboration-ui
```

The eight pure interaction tests cover zoom anchoring/bounds, handle scaling,
edge/center snapping, zoom-independent distances, distant references, hysteresis,
formation membership, containing regions and deterministic ties. Native Electron
checks use real mouse/wheel input and two process launches with temporary private
or shared profiles. They cover enlarged handle hit-testing and unchanged edge
paths, selection visibility, navigation over editors/resizers/readers/isolated
players, normal scroll, transient guides, rigid groups/multi-selection/regions,
and saved positions through Undo/Redo and reopening. No installed workspace is
opened. The existing keyboard/editor/reader/connection smoke suites remain checks
against regressions.

Both source and packaged interaction checks are wired into the Linux and Windows
build workflow. Local runtime validation is on Fedora. Each release attaches
installers only after both platforms pass their source and packaged checks,
including Windows installer installation, launch and uninstall. Mixed-OS manual
acceptance, display scaling and large real-world boards remain manual checks.
