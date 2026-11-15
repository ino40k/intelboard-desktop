# Collaboration preview validation

Local development validation, November 2026. All profiles, boards, identities,
files and invitations used here are synthetic. The owner's installed workspace
and the original web reference were not opened or changed. The original validation below was completed locally before publication. Tagged
build results in GitHub Actions provide the subsequent native Windows/Linux
validation status.

## Automated coverage

`npm test` covers the existing 27 cases and 19 new offline/media/persistence cases
(46 total); the real-network case is opt-in and runs separately. Some Node test
runner versions report per-file aggregates; `npm run test:collaboration` prints
the 19 new cases individually. The additional Tailcat scenario exercises three
isolated local databases with three real native helper processes.

| Requested scenario | Evidence |
| --- | --- |
| 1. Concurrent independent edits | Three-replica notes/position/connections test; exact logical equality |
| 2. Same-note editing | Concurrent character insertions, independent bold/italic marks, selective text undo; native editor/caret smoke |
| 3. Offline creation | Independent nodes over four and eight repeated generations |
| 4. Overlapping offline clusters | Deterministic offsets, preserved relative layout and untouched originals; whole new regions move together, existing containment stays for review |
| 5. Alternating online/offline | Repeated forwarding rounds and real helper disconnect/reconnect |
| 6. Three or more peers | Three real Tailcat peers; randomized four-replica histories |
| 7. Delete versus edit | Edited tombstone survives and restores; creation Undo retains remote text |
| 8. Crash during sync | Forced child-process death before/after commit; WAL recovery, equal journal/projection, integrity_check; rollback emits no acknowledgment |
| 9. Interrupted attachment | 8 MiB checkpoint/resume across media service restart; truncate uncommitted tail; corrupt hash rejected; exact bytes verified |
| 10. Duplicate/out-of-order | Reverse delivery, duplicate randomized histories, pending parents, malformed delayed child cannot poison a valid parent |
| 11. Resize lease disconnect | Actual renderer cursor/resize indication and handle exclusion; disconnect clears lease |
| 12. Invitation lifecycle | Real code acceptance, one-recipient flow, canceled and expired invitation rejection |
| 13. Member invitation | B invites C while owner A's helper is stopped |
| 14. Owner removal | Signed causal policy convergence, private recovery of displaced forks; real-network propagation |
| 15. Removed sender | New local edits/invites refused after removal; unauthorized policies and session impersonation rejected |
| 16. Background board sync | Editor switches to a private board, backend receives shared edit, reopening shows received content |
| 17. Private boards unchanged | Existing source/runtime suite, revision and save guards, shared exports import private, viewport independent |
| 18. Eventual convergence | Exact logical state on three/four replicas with multi-generation forks and randomized duplicated delivery |

Additional cases verify physical root/text replacement rejection, signed writer
equivocation quarantine, malformed decoding in a bounded worker, image-preview
lifetime after transfer cleanup, asset access scoped per board, and incomplete
shared-export rejection. A global/private hash match does not authorize serving
that file to a peer.

`npm run test:collaboration-ui` uses actual Electron/Chromium native input and
menus in hidden windows over two launches. It tests explicit sharing/remount,
local persistence, remote text with anchored caret, local-only text undo,
creator-bound new card IDs, native character-by-character empty-note caret checks and canvas Undo/Redo, world-coordinate cursors, foreign
resize handles, background board edits and independent viewport. The remote
text injection in this UI smoke comes from another signed engine replica, not
from a simulated DOM copy.

`npm run test:collaboration-network` uses real encrypted Tailcat connections and
public relay discovery, verifies a 192 KiB file byte-for-byte, allows B → C joining
without A, disconnects B/C for concurrent offline edits, reconnects and compares
all three logical states. It also kills a helper process, requires automatic
restart/catch-up, and propagates owner removal, including a peer that reconnects after being removed offline. The packaged-helper variant sets
`INTELBOARD_TEST_NETWORK_BINARY` to the bundled native executable.

Go's `go test ./...` verifies compact peer-address validation and rejects malformed
addresses, invalid region IDs and embedded custom relay configuration. The pinned
helper cross-compiles for Windows x64 with CGO disabled. This verifies compilation,
not execution on Windows.

## Reproducible commands

```sh
npm test
npm run test:collaboration
npm run build
npm run test:desktop
npm run test:collaboration-ui
npm run test:collaboration-network
cd native/network
go test ./...
```

For packaged tests after `npm run package:linux`:

```sh
INTELBOARD_TEST_BINARY=./release/linux-unpacked/intelboard npm run test:desktop
INTELBOARD_TEST_BINARY=./release/linux-unpacked/intelboard npm run test:collaboration-ui
INTELBOARD_TEST_NETWORK_BINARY=./release/linux-unpacked/resources/native/bin/intelboard-network npm run test:collaboration-network
npm run audit:release
```

These variables select test binaries; temporary test profiles remain separate.
The final Linux unpacked application passed both the private-board and collaboration smoke suites across two launches. The actual AppImage also passed collaboration smoke across two launches using its built-in extraction mode. The source and packaged privacy audit passed. Linux smoke tests preserve the normal Chromium sandbox. The Windows build
workflow includes equivalent source/packaged collaboration smoke steps and
installer acceptance. Consult the matching tag in GitHub Actions for hosted results.

## Performance sample

`node scripts/benchmark-collaboration.js 5000` creates a synthetic maximum-sized
board, explicitly shares it and performs 20 incremental note insertions through
the renderer-to-journal path. The measured sample was approximately 7.9 seconds
for initial sharing, 36 ms median / 50 ms slowest durable edit, and 2 ms cached
logical projection. This includes local transaction/fsync work but not network
latency, IPC serialization, React Flow rendering or media decoding. It is a local
benchmark, not a Windows or sustained multi-peer throughput claim. Normal edits
reuse document objects, validate changed entities through caches, and update
changed SQLite rows; they do not rewrite all history statuses per keystroke.

## Required field acceptance

- Two physical machines on different networks, Windows ↔ Fedora. Verify the new
  Windows installer, upgrade migration, sandboxed renderer, helper shutdown and
  unsigned installer behavior. Prior Windows acceptance applies to 1.0.3 only.
- Real relay-only/restrictive networks and public relay unavailability; confirm
  usable offline editing and eventual reconnect. Tailcat is experimental and
  public relays have rate/availability limits.
- A several-day exercise with alternating availability, invitations by members,
  owner removal, new media, three-way forwarding and complete offline reopening.
- Broader interactive checks for IME, emoji/RTL, copy/paste formatting, selection,
  drag/resize contention, regions/groups, layered intentional overlap and display
  scaling. Automated tests cover a useful subset, not every language/device.
- Larger mixed GIF/video/PDF/EPUB transfers, disk-full/power-loss faults, and
  long-running memory/history behavior. Existing decoder/import tests and the
  resume/hash/crash cases do not exhaust every file or fault combination.

The preview retains full history for long-offline reconciliation and enforces
document/history limits; destructive compaction is deliberately absent. Review
the limits and recovery behavior in [COLLABORATION.md](COLLABORATION.md) before
calling this release-ready. A published release requires the owner's approval.
