# Integrated application updates

Development preview **1.1.0-dev.6** introduces integrated updates. Existing releases through v1.1.0-dev.5 cannot discover updates themselves, so users must manually install the first updater-enabled package once. App identity, data folders, database version 2 and collaboration format 1 remain unchanged.

## Using updates

A small **green download icon** means a newer stable release is available. A separate **yellow icon** means a newer experimental release is available. Click an icon, review the version and confirm **Update**. The application downloads with progress, saves outstanding work, creates a recovery snapshot, installs, and restarts automatically. No second installation confirmation is required. Editing remains available during downloading; it is briefly frozen for the final save and restart.

Use the application menu **Updates → Check for updates…** to check manually. **Updates → Show experimental update notifications** controls yellow notifications and is saved across launches. Automatic checks run shortly after startup and every six hours, with concurrent checks combined. Checking never downloads application binaries. Offline checks and GitHub rate limits leave ordinary editing available. Checks use conditional requests where possible; there are no accounts, telemetry, separate servers or background services.

Cancel stops a pending download or waiting update. Installation cannot be cancelled once executable replacement starts. Retry uses an already verified download when available, verifies it again, and rechecks release eligibility. After an interrupted session, IntelBoard offers Retry rather than unexpectedly restarting at the next launch. File imports, captures, unfinished composition, active dialogs, save conflicts and incomplete local operations delay restart; they do not discard work. The app retries preparation while waiting.

### Windows 11

Install the first updater-enabled NSIS `.exe` over the existing per-user installation, using the same folder. Future updates use the verified NSIS installer silently with the existing directory and `--updated /S --force-run`. The application waits until the installer process starts successfully before quitting. No shell command or renderer-supplied executable is accepted. NSIS retains the app identity, registry installation entry, shortcuts and user-data location. Ordinary per-user installations do not request elevation; protected or administrator-managed installations may need manual maintenance instead.

These builds do not require paid Authenticode signing. Windows reputation warnings can still occur for the initial unsigned installer; antivirus or organizational policy can block unsigned executables. Ed25519 update signatures authenticate IntelBoard update packages but do not give them a Windows publisher certificate. Existing electron-updater Authenticode checks have not been disabled.

### Fedora AppImage

Launch the original AppImage, then either accept an update or choose **Updates → Set up Linux launcher…**. The confirmation explains the one-time copy and restart. IntelBoard creates a private, user-owned application folder:

- `${XDG_DATA_HOME:-~/.local/share}/IntelBoard/app/IntelBoard.AppImage`
- A stable desktop entry at `${XDG_DATA_HOME:-~/.local/share}/applications/org.intelboard.desktop` and a stable icon in the managed application folder.

Use that launcher thereafter. The original download is kept, so launching it directly would still run that old version. The setup refuses to replace a newer managed installation with an older image. AppImage managers that independently move or replace the managed image are outside this update flow.

Updates are staged on the same filesystem, hashed, made executable and synced before atomic rename. The old inode remains usable while running, and `.previous` retains the previous executable. A replacement journal repairs interrupted installation metadata to the executable actually present. It never automatically rolls back the executable after a possible database migration. A fixed, verified helper waits for the old process to exit, clears stale AppImage runtime environment variables and launches the stable path. No root access, cron job or system service is installed. Read-only folders, permission errors and disk-full failures leave recoverable files in place and show a retryable error.

FUSE-less launches using `APPIMAGE_EXTRACT_AND_RUN=1` are preserved by the managed launcher. Running an already extracted `AppRun` without the original `APPIMAGE` path does not enable integrated updates: launch the actual `.AppImage` for setup. Chromium's sandbox stays enabled.

## Release selection and verification

The main process reads the public `ino40k/intelboard-desktop` GitHub release API over HTTPS. It uses `semver`, not text sorting. Only versions strictly newer than the running version are eligible. A GitHub prerelease flag **or** a semantic prerelease suffix makes a release experimental. Drafts, superseded/withdrawn titles, missing packages, incomplete uploads, incompatible formats and unsigned releases are ignored. Stable 1.1.0 supersedes 1.1.0-dev.5. Stable 1.0.4 is never offered as an update to 1.1.0-dev.5. A preview at or below an available stable version is hidden. Returning to an older stable release is a separate manual downgrade requiring data compatibility review; the updater never performs it.

A release is ready only when its **`intelboard-update.json`** marker exists and verifies against an embedded Ed25519 public key. Its signed payload binds the repository, tag, version, channel, database/collaboration compatibility, filenames, sizes, SHA-256 and SHA-512 hashes. Both native packages and both channel metadata files must exist with matching GitHub asset metadata. Small metadata files are downloaded and hashed before a notification is offered. Eligibility is checked again when confirming and before installation.

`electron-updater` **6.8.11** provides the actual native NSIS/AppImage download, progress, cancellation, private cache and SHA-512 verification. A custom provider derives package identities exclusively from the signed marker. The main process also verifies the full package's signed size and SHA-256 before preparation and again before applying. It uses its own atomic AppImage application step because the library's standard AppImage installer unlinks the old image before replacing it.

Download requests and redirects are restricted to HTTPS on approved GitHub API, download and release-asset hosts. The renderer receives only status and opaque selection IDs; it cannot choose a URL, executable, installation arguments or public key. IPC is restricted to the trusted main frame. Sandboxing, context isolation and disabled renderer Node integration remain in force. This protects against modified release assets or checksums without the signing key; compromise of the maintainer's signing environment or an already trusted executable is outside that guarantee.

## Data and recovery

Windows `%APPDATA%/IntelBoard/` and Linux `${XDG_CONFIG_HOME:-~/.config}/IntelBoard/` remain the data locations. Updates never replace the data directory or delete attachments. The restart barrier commits editor changes, waits for local saves and asynchronous collaboration work, pauses new peer work, flushes Chromium storage and checkpoints SQLite WAL. It does not wait for collaborators to come online. Durable offline edits and the existing collaboration identity/history remain in SQLite and resume through the existing protocol after restart.

Before executable replacement, a consistent SQLite backup is created under `update-recovery/<timestamp-id>/` inside user data, alongside application preferences, window settings and restoration notes. SQLite's backup API includes committed WAL data. Attachments remain in the existing `assets/` folder; this snapshot is not a portable full workspace export. Snapshots are retained rather than silently deleted; inspect their disk usage periodically.

Before an older database is migrated, a separate immutable pre-migration snapshot is created. The current migrations remain additive/transactional. A database newer than this executable supports is rejected before replacing the prior recovery snapshot. `shared/update-compatibility.js` declares database read/write and collaboration formats; future format changes must update that declaration, real migrations and tests together. Existing collaboration protocol validation remains responsible for peer compatibility; updating does not silently translate unsupported peer formats.

For recovery, close all IntelBoard processes and first copy the **entire** user-data directory elsewhere. Preserve assets, Chromium settings, WAL/SHM and recovery folders. Use the matching compatible application version; never run an older executable blindly against a newer database. A retained recovery database may be copied into a separate recovery workspace after moving aside its current database/WAL/SHM. `preferences.json` contains application localStorage entries for assisted preference restoration; it is not a complete Chromium profile. Prefer restoration of the entire closed-app data backup when available. Do not delete the original workspace until the restored copy has been verified. The `.previous` executable is a recovery aid, not permission to bypass schema compatibility checks.

## Validation and current limits

Local validation on Fedora uses synthetic profiles only. Actual **9.0.0 → 9.0.1 stable** and **9.0.0 → 9.1.0-dev.1 experimental** AppImage tests exercised:

- Visible confirmation; no binary download on check, opening the popup or Cancel.
- The real electron-updater HTTP downloader and intermediate progress, signed-manifest validation and full-package hashes.
- A real note edit inside the save debounce immediately after download, then final save, backup, atomic installation and automatic restart.
- Running version after restart; board IDs/content, attachment bytes, theme/preferences, shared-board identity and unsynchronized offline edits.
- Launcher path, executable permissions, previous-image retention and preservation of the original downloaded image.

The feed is synthetic and package downloads use a loopback server behind a main-process smoke-test gate. Production HTTPS and redirect restrictions remain enabled. These tests are not a test of GitHub's live CDN or a claim that historical, updater-free v1.0.4 can update itself.

Unit tests cover stable/preview ordering, incomplete and tampered releases, incompatible formats, failures/rate limits, check coalescing, cancellation/retry, interrupted verified caches, permission/disk-full/symlink failures, interrupted atomic replacement, WAL backups, migrations/future-schema rejection and collaboration draining. Release tests prove fail-closed signing, upload verification, marker-last ordering and immutability with a fake GitHub interface; they make no external writes.

**Windows 11 native update/restart tests passed on November 16, 2026**, for both stable 9.0.0 → 9.0.1 and experimental 9.0.0 → 9.1.0-dev.1. Each used a real NSIS installer in a directory containing spaces, retained exactly one installation and two shortcuts, and verified the restarted version and synthetic workspace data. The workflow repeats these tests on its disposable Windows runner. See [cross-platform updater validation](UPDATER_VALIDATION.md) for the test setup and fixes. Actual antivirus interruptions, power loss, live CDN download, high-DPI UI and long-lived multi-peer sessions still merit manual acceptance testing.

Run locally after building the native helper and frontend:

```sh
npm test
npm run build:network
npm run notices:network
npm run build
npm run updates:fixtures
npm run test:updater-e2e
```

Linux needs a graphical session or `xvfb-run -a npm run test:updater-e2e`. Keep the sandbox enabled. On Windows, use a **clean disposable VM/user**, set `$env:INTELBOARD_DISPOSABLE_VM='1'`, then run the same commands. The test refuses an existing IntelBoard database or registered installation. Test packages and synthetic screenshots/results are local ignored outputs, never release assets. See [the maintainer steps](RELEASING.md) for publication.
