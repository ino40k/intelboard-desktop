# Local-first collaboration — 1.1.0 development preview

This development preview is distributed separately from stable 1.0.4, which does
not include collaboration. The build workflow checks the native Windows installer;
two-machine, mixed Windows/Fedora field acceptance remains necessary before a
stable collaboration release. See the validation report and tagged build results.

## Using it

1. Open a board, choose **Share**, enter a display name, and explicitly enable
   collaboration. Unshared boards keep their original storage and undo behavior.
2. Choose **Create invitation**, copy the code, and send it privately. Codes
   expire after 15 minutes, are single-recipient, and can be revoked. Keep the
   inviting app open while the recipient joins.
3. On the recipient's library screen, choose **Join shared board**, enter a name
   and the code. Cards arrive first; media downloads separately. Ordinary editing
   remains available throughout synchronization.
4. Once media finishes, the complete board works without a network or another
   participant. Leave IntelBoard open to synchronize every shared board, even
   when viewing a private board. Closing it stops networking; reopening retries.
5. Share controls show reachable collaborators, transfer progress, errors/retry,
   invitations and recovery. Only the owner sees participant removal controls.

**Synced with connected peers** describes the peers currently reachable; it does
not assert that every offline replica has delivered all its changes. **Saved**
describes the local durable copy, independently of network delivery. Export waits
for the initial structural copy and its required files; editing does not wait.
Ordinary `.intelboard` exports/imports remain private copies, without invitation
tokens, cryptographic identities, membership or a connection to the original.

## Architecture and data integrity

Yjs 13.6.33 is the merge engine. Tailcat carries messages and files; it does not
choose winners or replace board snapshots. Yjs was selected over Automerge for
its established rich-text, relative-position and scoped undo APIs and its fit
with IntelBoard's existing contenteditable editor. See [Yjs updates](https://docs.yjs.dev/api/document-updates),
[Y.Text](https://docs.yjs.dev/api/shared-types/y.text),
[relative positions](https://docs.yjs.dev/api/relative-positions), and
[UndoManager](https://docs.yjs.dev/api/undo-manager).

Each shared board is a Y.Doc with permanent node/connection maps, nested property
maps, Y.Text fields, attachment manifests and geometry history. Notes, titles,
descriptions, captions and connection labels edit character sequences. Formatting
uses independent bold/italic/underline attributes and UTF-16 offsets compatible
with the original editor. Diffs affect changed character spans; text is not a
last-writer-wins string. Relative selections keep the local caret anchored when
remote characters arrive; remote edits queue during IME composition. Other
participants' note editing is indicated on the card. Remote text-range/caret
decorations inside the note are not implemented.

Geometry, colors, group identity and other scalar properties use deterministic
Y.Map conflict resolution. A position is an atomic x/y pair. Incompatible offline
geometry changes retain before/after entries for review. Canvas undo tracks only
local canvas operations; each text editor has a local-origin undo scope. Creation
is initialized outside undo capture and activated through a soft-delete flag, so
undoing creation cannot physically destroy another person's subsequent edits.

The additive SQLite schema-2 migration preserves all original tables and data.
Shared edits bypass revision-controlled whole-board replacement: the journal and
incremental materialized board rows commit in one FULL-synchronous transaction
before an update is acknowledged or sent. Failed transactions emit no accepted
event. Shared snapshot replacement through the old private save API is refused.
Private boards retain the original save/draft mechanism. The renderer also keeps
an incremental outbox, retries exact updates idempotently, and flushes at close.

The signed immutable journal is authoritative; a Yjs checkpoint is recorded every
64 records. Reopening rebuilds from authenticated records, so a stale checkpoint
cannot discard later edits. Causal parents, before-vectors, per-session signed
writer chains, membership grants and bounded update validation are checked before
acceptance. New Yjs structs must belong to the signer's session. Root entities and
text containers cannot be physically deleted/replaced; new object UUIDs are bound
to creator, session and random nonce. The owner's signed genesis lists preserved
original IDs. Equivocating writer branches and their dependents are quarantined.

Missing records are requested using paged inventories and bounded batches.
Duplicate application is harmless; children received before parents remain
pending. Any authorized peer can forward signed history received earlier from
another person. A → B → C works without A and C ever meeting, and repeated offline
forks merge without comparing board save timestamps. Raw SQLite files are never
sent to peers. Local pan/zoom remains outside the shared document.

## Tailcat integration

`native/network` is a small Go child process pinned to the same Tailcat revision
used by [Handoff](https://github.com/ino40k/handoff):
`v0.7.1-0.20261007201807-52fbad323e9d`. Handoff was inspected as a reference;
its persisted listener identity, compact-address validation, distinct outbound
client keys and retry patterns informed this integration. No Handoff application
data or configuration is distributed.

The helper owns Tailcat/WireGuard transport only. A bounded stdio protocol exposes
start/dial/send/close, not a shell, filesystem or board API. A persistent listener
key, PSK and public DERP region keep discovery addresses usable after reopening.
Outbound connections use distinct temporary keys to avoid competing DERP sessions.
Application identity proofs bind each Ed25519 identity to the actual Tailcat
connection key. Control and bulk transfers use separate connections. The helper
exits with the app; there is no installed daemon, tailnet, VPN or account.

[Tailcat](https://github.com/tailscale/tailcat) is experimental. Direct UDP is
preferred when possible; public DERP relays provide a fallback with rate limits
and no collaboration availability guarantee. Relay discovery and relays are still
external infrastructure: no account/server setup does not mean no infrastructure.
Both participants must be reachable together to exchange changes. There is no
offline mailbox or cloud copy. Firewalls/proxies may prevent connection; local
editing remains available and retry is automatic. A failed/retired persisted
public relay region may require a future address-rotation/discovery improvement.
This build uses public compact addresses and rejects embedded custom relay hosts.

## Invitations, membership and removal

Each installation stores an Ed25519 identity locally, outside the renderer. The
signed genesis identifies the board owner. Any current member can sign a grant
linked to their own grant; receivers validate the chain. Invitation codes carry a
signed, 256-bit random bearer token for one board and an online host address. The
host stores the token hash, expiration, revocation and accepted recipient; retry
by that same recipient is safe. Tokens and private keys are not exported.

Only the owner can sign the monotonic removal policy chain. Removed identities
lose future access on peers that learn the policy. A policy explicitly records the
owner's acknowledged causal past: removed participants' unacknowledged forks and
dependent branches are quarantined consistently on all replicas. A previously
visible branch displaced by this reconciliation gets a private recovery snapshot.
Existing downstream grants explicitly known to the owner survive their inviter's
removal; unknown grants by removed inviters do not. Policy propagation may wait
for a chain of reachable participants; the owner need not serve ordinary edits.

Removal cannot erase previously downloaded data, stop an isolated device before
it learns the policy, or prevent an authorized person deliberately copying data
outside the application. The interface explains the downloaded-copy limitation.
Do not clone a live installation identity onto simultaneously active computers;
join a new installation normally. There are no additional administrator roles.

## Media, presence and layout

Originals have SHA-256 manifests and content-derived IDs. Canonical local aliases
preserve the private file system. A manifest cannot reference an arbitrary private
UUID or authorize serving an existing private file: access is scoped to its board.
Within-board repeated hashes reuse verified files; across unrelated boards a
matching global hash alone does not grant access or skip the verified transfer.

Transfers use 64 KiB chunks and checkpoint the offset only after fsync. Restart
truncates bytes beyond the committed offset and resumes. Completion verifies the
entire SHA-256 hash and reuses the existing image/video/EPUB validation and preview
pipeline. Smaller files go first on a separate bulk lane. Missing media shows a
placeholder; text, cursors and control messages continue. Original previews remain
available after temporary transfer records are removed. Supported originals keep
the existing 50 MB per-file limit. A peer must possess the complete requested file
to serve it; partial files are not forwarded as complete originals.

Cursors use board coordinates and each viewer's own camera. Presence is throttled
to 20 Hz with a two-second heartbeat and five-second expiry; no mouse movement is
written as history. Drag/resize previews are ephemeral; durable geometry commits
when the interaction ends. Resize leases disable handles for a known foreign
lease, expire after silence and clear on disconnect. Simultaneous lock acquisition
has the unavoidable network race: identities deterministically choose a winner
when both leases arrive; a losing local preview is discarded. Offline editing is
never prevented, and durable conflicting geometry remains recoverable.

Creation provenance records actor, batch and observed Yjs clocks. Deterministic
derived offsets separate concurrent offline-created clusters, preserving relative
positions and connections. Existing nodes, explicit later positioning and known
intentional region/group relationships are protected. Group/region constraints
that cannot be moved safely produce a recovery-panel explanation. Offsets are
computed from merged state, not broadcast as feedback moves. Repeated delivery of
the same state does not shift them again. Later newly discovered concurrent
clusters may require a different offset. Dragging an offset cluster pins its
chosen displayed positions. Recovery offers **Keep displayed arrangement** or
**Use authored positions**, as well as individual geometry restoration.

Deleted cards/connections are soft tombstones; concurrent text remains available
through **Deleted items & recovery**. Restoring endpoints makes restored
connections visible. Private recovery copies are listed for 30 days; geometry
review shows the latest 100 records (20 at a time in the UI).

## Limits and remaining acceptance

The initial bound is 32 members per board, 64 transport connections per app,
5,000 live cards, 10,000 live connections, 10,000 attachment manifests, 32 MB active
structure, 2 MB individual update, and 64 MB initial renderer document. Multiple
large simultaneous boards can reach the connection bound; synchronization retries
as slots become available. This is a small-team implementation, not an unbounded
mesh. Very large single editing transactions can exceed the update bound and need
to be split. Invalid/over-limit work remains in the local outbox for recovery.

History remains append-only, including soft-deleted content, to preserve long-offline
merges. There is no automatic destructive CRDT history compaction. Additional
guards cap historical cards at 15,000, connections at 30,000 and geometry entries at
50,000. Long-lived busy boards can reach these limits. Making a private copy and
explicitly sharing a fresh copy starts a new history; former invitations do not
transfer. A future coordinated retirement/compaction protocol must preserve the
ability to import stale offline work before reducing these limits safely.

The application still stores local files/database in the OS profile without
application-level disk encryption. Use OS storage/account protection as needed.
Network encryption does not change this existing local storage behavior.

Validation uses synthetic profiles only. See [COLLABORATION_VALIDATION.md](COLLABORATION_VALIDATION.md)
for exact coverage and commands. Before publishing, test two physical machines
across different NATs, Fedora ↔ Windows, relay-only/restrictive networks, display
scaling, IME/composition, larger real document mixes and multi-day use. The current
automated network test uses real Tailcat with three temporary local backends and
three native helpers; Electron tests separately exercise the real editor. It does
not substitute for mixed-OS, two-machine acceptance.

## Build and test

Install Node 24 LTS, Go 1.27.1 or newer compatible with `native/network/go.mod`,
and normal native platform build tools. End users need none of these tools.

```sh
npm ci
npx install-electron --no
npm run build:network
npm run notices:network
npm test
npm run build
npm run test:desktop
npm run test:collaboration-ui
npm run test:collaboration-network  # real public Tailcat/DERP access required
npm start
```

Use `npm run package:linux` on Linux and `npm run package:win` on Windows. Both
build and bundle the helper automatically. `INTELBOARD_GO` may point to an isolated
Go executable. Native Linux builds produce `release/*.AppImage`; Windows produces
the standard per-user NSIS installer. `node scripts/build-network.js windows` can
cross-compile the networking helper on Linux; this does not build or validate the
Windows installer. The current preview is `1.1.0-dev.2`. Download the matching Windows and Linux builds from its GitHub prerelease page.
