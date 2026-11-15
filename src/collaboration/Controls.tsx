import { useCallback, useEffect, useState } from "react";
import { Share2, Users, Copy, LoaderCircle, X } from "lucide-react";
import { Modal } from "../App";
import { collaboration, type SharedBoardController } from "./controller";
import type { Viewport } from "@xyflow/react";

const labels: Record<string, string> = {
  offline: "Offline · saved here",
  waiting: "Waiting for collaborators",
  syncing: "Synchronizing changes…",
  attachments: "Downloading attachments…",
  synced: "Synced with connected peers",
  pending: "Sharing local changes…",
  error: "Sync needs attention",
  removed: "Access removed · local copy retained",
};
export function useCollaborationStatus(
  controller?: SharedBoardController | null,
) {
  const [, render] = useState(0);
  useEffect(
    () => controller?.subscribePresence(() => render((n) => n + 1)),
    [controller],
  );
  return controller?.network;
}
export function CollaborationControls({
  boardId,
  controller,
  shared,
  onShare,
}: {
  boardId: string;
  controller: SharedBoardController | null;
  shared: boolean;
  onShare: () => Promise<void>;
}) {
  const [open, setOpen] = useState(
    sessionStorage.getItem("intelboard.collaboration.open") === boardId,
  );
  const [name, setName] = useState(
    localStorage.getItem("intelboard.collaboration.name") || "",
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [invite, setInvite] = useState<any>(null),
    [recovery, setRecovery] = useState<any>(null);
  const close = useCallback(() => setOpen(false), []),
    status = useCollaborationStatus(controller);
  useEffect(() => {
    if (open) sessionStorage.removeItem("intelboard.collaboration.open");
  }, [open]);
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await controller?.refreshStatus();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        className={`collaboration-button ${shared ? "is-shared" : ""}`}
        onClick={() => setOpen(true)}
        title={
          shared
            ? labels[status?.network] || "Collaboration"
            : "Share this board"
        }
      >
        {shared ? <Users size={16} /> : <Share2 size={16} />}
        <span>
          {shared
            ? status?.connected
              ? `${status.connected + 1} collaborators`
              : "Shared"
            : "Share"}
        </span>
        {shared && (
          <i className={`collaboration-dot ${status?.network || "waiting"}`} />
        )}
      </button>
      {open && (
        <Modal
          title={shared ? "Board collaboration" : "Share this board"}
          onClose={close}
        >
          {!shared ? (
            <>
              <p>
                This board is private. Enable collaboration to invite people and
                keep a complete local copy on each device.
              </p>
              <label>
                Your display name
                <input
                  autoFocus
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                />
              </label>
              <button
                className="primary-button"
                disabled={busy || !name.trim()}
                onClick={() =>
                  void act(async () => {
                    await collaboration("name", undefined, {
                      name: name.trim(),
                    });
                    localStorage.setItem(
                      "intelboard.collaboration.name",
                      name.trim(),
                    );
                    sessionStorage.setItem(
                      "intelboard.collaboration.open",
                      boardId,
                    );
                    await onShare();
                  })
                }
              >
                {busy ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <Share2 size={16} />
                )}{" "}
                Enable collaboration
              </button>
            </>
          ) : (
            <>
              <p className="collaboration-status" role="status">
                {labels[status?.network] ||
                  "Opening local collaboration state…"}
              </p>
              <p className="collaboration-detail">
                Local edits save on this device first. Other people can keep
                working offline; this status describes currently reachable
                collaborators.
              </p>
              {status?.transfer && (
                <div className="collaboration-progress">
                  <progress
                    max={status.transfer.total}
                    value={status.transfer.received}
                  />
                  <span>
                    {(status.transfer.received / 1048576).toFixed(1)} /{" "}
                    {(status.transfer.total / 1048576).toFixed(1)} MB
                  </span>
                </div>
              )}
              {status?.error && (
                <p className="alert" role="alert">
                  {status.error}
                  <button
                    onClick={() =>
                      void act(async () => {
                        await collaboration("retry", boardId);
                      })
                    }
                  >
                    Retry
                  </button>
                </p>
              )}
              {status?.active !== false && (
                <>
                  <button
                    className="primary-button"
                    disabled={busy || !controller}
                    onClick={() =>
                      void act(async () =>
                        setInvite(await collaboration("invite", boardId)),
                      )
                    }
                  >
                    {busy ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <Share2 size={16} />
                    )}{" "}
                    Create invitation
                  </button>
                  <p className="collaboration-detail">
                    Any current collaborator can invite people. The inviter must
                    be online when a code is accepted.
                  </p>
                </>
              )}
              {invite && (
                <div className="collaboration-invitation">
                  <label>
                    Private, one-use invitation
                    <textarea
                      readOnly
                      value={invite.code}
                      aria-label="Invitation code"
                      onFocus={(e) => e.target.select()}
                    />
                  </label>
                  <span>
                    Expires{" "}
                    {new Date(invite.expires).toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                  <div className="collaboration-actions">
                    <button
                      onClick={() =>
                        void act(async () => {
                          await navigator.clipboard.writeText(invite.code);
                        })
                      }
                    >
                      <Copy size={14} /> Copy code
                    </button>
                    <button
                      onClick={() =>
                        void act(async () => {
                          await collaboration("cancel-invite", boardId, {
                            id: invite.id,
                          });
                          setInvite(null);
                        })
                      }
                    >
                      <X size={14} /> Revoke invitation
                    </button>
                  </div>
                  <p className="collaboration-detail">
                    Send this code privately. It grants access to this board and
                    its attachments.
                  </p>
                </div>
              )}
              <ul className="collaboration-members">
                {status?.members?.map((m: any) => (
                  <li key={m.identity}>
                    <span
                      className="collaboration-avatar"
                      style={{ background: m.color }}
                    >
                      {m.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span>
                      {m.name}
                      {m.identity === status.identity ? " (you)" : ""}
                      <small>
                        {m.owner ? "Owner · " : ""}
                        {m.online ? "Online" : "Offline"}
                      </small>
                    </span>
                    {status.owner &&
                      !m.owner &&
                      m.identity !== status.identity && (
                        <button
                          onClick={() => {
                            if (
                              window.confirm(
                                `Remove ${m.name}? They retain downloaded copies. Disconnected peers learn of removal when they reconnect.`,
                              )
                            )
                              void act(async () => {
                                await collaboration("remove", boardId, {
                                  identity: m.identity,
                                });
                              });
                          }}
                        >
                          Remove
                        </button>
                      )}
                  </li>
                ))}
              </ul>
              {status?.quarantined > 0 && (
                <p className="alert">
                  Some changes could not be merged yet. Reconnect, or review
                  available recovery copies.
                </p>
              )}
              <div className="collaboration-actions">
                <button
                  onClick={() =>
                    void act(async () =>
                      setRecovery(await collaboration("recovery", boardId)),
                    )
                  }
                >
                  Deleted items & recovery
                </button>
                <button
                  onClick={() =>
                    void act(async () => {
                      await controller?.flush();
                      if (controller?.outbox.length)
                        throw new Error(
                          "Wait for local changes to save before making a private copy.",
                        );
                      const result = await collaboration(
                        "private-copy",
                        boardId,
                      );
                      localStorage.setItem("intelboard.last", result.boardId);
                      location.reload();
                    })
                  }
                >
                  Make a private copy
                </button>
              </div>
              {recovery && (
                <section className="collaboration-recovery">
                  <h3>Recoverable content</h3>
                  {!!recovery.layout?.shifted && (
                    <div>
                      <span>
                        {recovery.layout.shifted} items were offset to separate
                        overlapping offline creations. Original positions are
                        retained.
                      </span>
                      <button
                        onClick={() =>
                          void act(async () => {
                            await collaboration("layout-accept", boardId);
                            setRecovery(
                              await collaboration("recovery", boardId),
                            );
                          })
                        }
                      >
                        Keep displayed arrangement
                      </button>
                      <button
                        onClick={() =>
                          void act(async () => {
                            await collaboration("layout-authored", boardId);
                            setRecovery(
                              await collaboration("recovery", boardId),
                            );
                          })
                        }
                      >
                        Use authored positions
                      </button>
                    </div>
                  )}
                  {!!recovery.layout?.warnings && (
                    <p className="alert">
                      Overlapping offline creations touch an existing region or
                      group. Their positions were preserved for you to arrange.
                    </p>
                  )}
                  {recovery.deleted?.map((node: any) => (
                    <div key={node.id}>
                      <span>
                        {(
                          node.data.text ||
                          node.data.title ||
                          node.data.filename ||
                          "Deleted item"
                        ).slice(0, 80)}
                      </span>
                      <button
                        onClick={() =>
                          void act(async () => {
                            await collaboration("restore-node", boardId, {
                              id: node.id,
                            });
                            setRecovery(
                              await collaboration("recovery", boardId),
                            );
                          })
                        }
                      >
                        Restore item
                      </button>
                    </div>
                  ))}
                  {recovery.edges?.map((edge: any) => (
                    <div key={edge.id}>
                      <span>
                        {edge.label || "Deleted connection"} · restore its cards
                        first
                      </span>
                      <button
                        onClick={() =>
                          void act(async () => {
                            await collaboration("restore-edge", boardId, {
                              id: edge.id,
                            });
                            setRecovery(
                              await collaboration("recovery", boardId),
                            );
                          })
                        }
                      >
                        Restore connection
                      </button>
                    </div>
                  ))}
                  {recovery.forks?.map((fork: any) => (
                    <div key={fork.id}>
                      <span>
                        {fork.reason}
                        <small>{new Date(fork.created).toLocaleString()}</small>
                      </span>
                      <button
                        onClick={() =>
                          void act(async () => {
                            const result = await collaboration(
                              "restore-fork",
                              boardId,
                              { id: fork.id },
                            );
                            localStorage.setItem(
                              "intelboard.last",
                              result.boardId,
                            );
                            location.reload();
                          })
                        }
                      >
                        Open private recovery copy
                      </button>
                    </div>
                  ))}
                  <details>
                    <summary>Recent positions and sizes</summary>
                    {recovery.geometry
                      ?.slice(-20)
                      .reverse()
                      .map((g: any) => (
                        <div key={g.id}>
                          <span>Position or size change</span>
                          <button
                            onClick={() =>
                              void act(async () => {
                                await collaboration(
                                  "restore-geometry",
                                  boardId,
                                  { id: g.id },
                                );
                              })
                            }
                          >
                            Restore previous geometry
                          </button>
                        </div>
                      ))}
                  </details>
                  {!recovery.deleted?.length && !recovery.forks?.length && (
                    <p>No deleted items or quarantined copies.</p>
                  )}
                </section>
              )}
            </>
          )}
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}
    </>
  );
}
export function JoinCollaboration({
  onClose,
  onJoined,
}: {
  onClose: () => void;
  onJoined: (boardId: string) => Promise<void>;
}) {
  const [name, setName] = useState(
      localStorage.getItem("intelboard.collaboration.name") || "",
    ),
    [code, setCode] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const join = async () => {
    setBusy(true);
    setError("");
    try {
      await collaboration("name", undefined, { name: name.trim() });
      localStorage.setItem("intelboard.collaboration.name", name.trim());
      const result = await collaboration("join", undefined, {
        code: code.trim(),
      });
      await onJoined(result.boardId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Join a shared board" onClose={onClose}>
      <p>
        Ask a collaborator for a private invitation code. They must be online
        for the initial connection.
      </p>
      <label>
        Your display name
        <input
          autoFocus
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        Invitation code
        <textarea
          value={code}
          maxLength={16000}
          onChange={(e) => setCode(e.target.value)}
          placeholder="intelboard1.…"
        />
      </label>
      <button
        className="primary-button"
        disabled={busy || !name.trim() || !code.trim()}
        onClick={() => void join()}
      >
        {busy ? (
          <LoaderCircle className="spin" size={16} />
        ) : (
          <Users size={16} />
        )}{" "}
        {busy ? "Connecting to collaborator…" : "Join board"}
      </button>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <p className="collaboration-detail">
        You can edit locally while files arrive. Once downloaded, the board
        works offline too. An invitation cannot retrieve files from an offline
        computer.
      </p>
    </Modal>
  );
}
export function RemoteCursors({
  controller,
  viewport,
}: {
  controller: SharedBoardController | null;
  viewport: Viewport;
}) {
  const state = useCollaborationStatus(controller);
  return (
    <div className="collaboration-cursors" aria-hidden="true">
      {state?.presence
        ?.filter((p: any) => p.identity !== controller?.actor && p.cursor)
        .map((p: any) => (
          <div
            className="collaboration-cursor"
            key={p.identity}
            style={{
              transform: `translate(${p.cursor.x * viewport.zoom + viewport.x}px,${p.cursor.y * viewport.zoom + viewport.y}px)`,
              color: p.color,
            }}
          >
            <svg width="15" height="19" viewBox="0 0 15 19">
              <path
                d="M1 1L13 11L7 12L4 18Z"
                fill="currentColor"
                stroke="var(--surface)"
              />
            </svg>
            <span style={{ background: p.color }}>{p.name}</span>
          </div>
        ))}
    </div>
  );
}
export function NodePresence({
  controller,
  id,
}: {
  controller?: SharedBoardController | null;
  id: string;
}) {
  const state = useCollaborationStatus(controller),
    person = state?.presence?.find(
      (p: any) =>
        p.identity !== controller?.actor &&
        (p.resize === id || p.editing === id || p.selection?.includes(id)),
    );
  if (!person) return null;
  return (
    <span
      className="collaboration-node-presence"
      style={{ borderColor: person.color, color: person.color }}
    >
      {person.name}
      {person.resize === id
        ? " · resizing"
        : person.editing === id
          ? " · editing"
          : ""}
    </span>
  );
}
