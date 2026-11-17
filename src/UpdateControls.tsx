import { useEffect, useState } from "react";
import { Download, LoaderCircle, X } from "lucide-react";
import { prepareForUpdate, releaseUpdatePreparation } from "./updateSafety";

export type UpdateState = {
  installed: string;
  phase: string;
  experimental: boolean;
  checked: boolean;
  available: Record<
    string,
    { version: string; id: string; channel: string } | null
  >;
  error: string;
  message: string;
  progress: { percent: number; transferred: number; total: number } | null;
  target?: { version: string; channel: string };
  integrationRequired?: boolean;
};
export function UpdateBridge() {
  useEffect(
    () =>
      window.intelboard.onUpdatePreparation(async (action) => {
        if (action === "release") {
          releaseUpdatePreparation();
          return {};
        }
        return prepareForUpdate();
      }),
    [],
  );
  return null;
}
const size = (n: number) =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(1)} GB`
    : n >= 1024 ** 2
      ? `${(n / 1024 ** 2).toFixed(1)} MB`
      : `${Math.round(n / 1024)} KB`;
export function UpdateControls() {
  const [state, setState] = useState<UpdateState | null>(null),
    [choice, setChoice] = useState<{
      version: string;
      id: string;
      channel: string;
    } | null>(null),
    [expanded, setExpanded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    void window.intelboard.updater("status").then((s) => {
      if (active) setState(s as UpdateState);
    });
    const off = window.intelboard.onUpdater((s) => {
      setState(s as UpdateState);
      if ((s.message || s.error) && ["idle", "checking"].includes(s.phase))
        setNotice(s.message || s.error);
    });
    return () => {
      active = false;
      off();
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  if (!state) return null;
  const active = !["idle", "checking", "error"].includes(state.phase),
    failed = state.phase === "error",
    target = state.target;
  if (
    !active &&
    !failed &&
    !choice &&
    !notice &&
    !state.available.stable &&
    !state.available.experimental
  )
    return null;
  const command = async (action: string) => {
    setError("");
    try {
      await window.intelboard.updater(action);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div
      className="update-controls"
      onKeyDownCapture={(event) => {
        if (event.key === "Escape" && (choice || expanded)) {
          event.preventDefault();
          event.stopPropagation();
          setChoice(null);
          setExpanded(false);
        } else if (
          (event.target as Element).closest(".update-popover") ||
          event.key === "Enter" ||
          event.key === " "
        )
          event.stopPropagation();
      }}
    >
      {!active &&
        !failed &&
        ["stable", "experimental"].map((channel) => {
          const c = state.available[channel];
          return (
            c && (
              <button
                key={channel}
                className={`icon-button update-icon update-${channel}`}
                title={`${channel === "stable" ? "Update" : "Experimental update"} ${c.version}`}
                aria-label={`${channel === "stable" ? "Stable" : "Experimental"} update ${c.version} available`}
                onClick={() => {
                  setChoice(c);
                  setError("");
                }}
              >
                <Download size={18} />
              </button>
            )
          );
        })}
      {(active || failed) && (
        <button
          className={`update-running update-${target?.channel || "stable"}`}
          onClick={() => setExpanded(!expanded)}
          aria-label="Update progress"
        >
          {active ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <Download size={16} />
          )}
          <span>
            {state.phase === "downloading"
              ? `${Math.floor(state.progress?.percent || 0)}%`
              : failed
                ? "Retry update"
                : "Updating…"}
          </span>
        </button>
      )}
      {choice && (
        <div
          className="update-popover"
          role="dialog"
          aria-label="Confirm application update"
        >
          <strong>
            {choice.channel === "experimental"
              ? "Experimental update"
              : "IntelBoard update"}
          </strong>
          <p>
            IntelBoard {choice.version} is available.
            {choice.channel === "experimental"
              ? " This experimental build may contain unfinished features or bugs."
              : ""}
          </p>
          {state.integrationRequired && (
            <p className="muted">
              This also sets up your Linux launcher for future updates. Your
              original AppImage is kept.
            </p>
          )}
          <p className="muted">
            The app will save your work and restart after downloading.
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="update-actions">
            <button disabled={busy} onClick={() => setChoice(null)}>
              Cancel
            </button>
            <button
              className="primary-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await window.intelboard.updater("begin", {
                    channel: choice.channel,
                    id: choice.id,
                  });
                  setChoice(null);
                  setExpanded(true);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Checking…" : "Update"}
            </button>
          </div>
        </div>
      )}
      {expanded && (active || failed) && (
        <div
          className="update-popover"
          role="dialog"
          aria-label="Application update progress"
        >
          <button
            className="icon-button update-close"
            aria-label="Hide update progress"
            onClick={() => setExpanded(false)}
          >
            <X size={16} />
          </button>
          <strong>
            Updating IntelBoard{target ? " " + target.version : ""}
          </strong>
          {state.phase === "downloading" && (
            <>
              <progress max={100} value={state.progress?.percent || 0} />
              <p>
                {Math.floor(state.progress?.percent || 0)}% ·{" "}
                {size(state.progress?.transferred || 0)}
                {state.progress?.total
                  ? " of " + size(state.progress.total)
                  : ""}
              </p>
            </>
          )}
          <p role={failed ? "alert" : undefined}>
            {state.error || state.message || "Downloading your update…"}
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="update-actions">
            {state.phase !== "installing" && (
              <button onClick={() => void command("cancel")}>
                Cancel update
              </button>
            )}
            {failed && (
              <button
                className="primary-button"
                onClick={() => void command("retry")}
              >
                Retry
              </button>
            )}
          </div>
        </div>
      )}
      {notice && (
        <div className="update-notice" role="status">
          {notice}
          <button
            className="icon-button"
            aria-label="Dismiss update notice"
            onClick={() => setNotice("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
