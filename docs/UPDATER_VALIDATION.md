# Integrated updater validation

Validation date: November 16, 2026. Updater-enabled source: 1.1.0-dev.6. All workspace and peer data used by the automated checks was synthetic.

## Native Windows 11 VM

Windows 11 Home 26H2 x64 build 26300.9457; Node 24.20.0, npm 12.2.0, Go 1.27.1, PowerShell 7.7.0, Electron 45.0.0, electron-builder 26.15.3 and electron-updater 6.8.11. Tests used a clean standard-user profile, the VM's local Windows drive and a graphical session. Source restoration verified every transferred file before testing.

- Unit checks: 80 tests, 75 passed, zero failures, five expected skips (four AppImage-only and the opt-in live Tailcat test). Production dependency audit reported zero advisories.
- Production Windows x64 helper, frontend, NSIS installer, block map and normalized update metadata built successfully.
- Development and packaged desktop, collaboration, private-canvas and shared-canvas checks passed, each across two launches. Windows smoke deadlines were increased from 30 to 60 seconds for low-resource VMs; initial timing failures passed on rerun without disabling Electron security.
- Installed production application acceptance passed before uninstalling it. The privacy audit passed over source, frontend and the actual Windows ASAR. Synthetic probes also confirmed it rejected excluded paths and private-content markers.
- Real stable 9.0.0 → 9.0.1 and experimental 9.0.0 → 9.1.0-dev.1 NSIS updates downloaded and installed, then restarted into the expected running version. Installation paths contained spaces. The registry retained one installation with its original key and directory and the new version. Exactly two Desktop/Start Menu shortcuts retained their paths and targets.
- Opening and cancelling confirmation downloaded zero packages. Confirming downloaded one actual native installer per channel, with intermediate progress and signed integrity checks. Restarts preserved the pending note edit inside the save debounce, board IDs/content, attachment hash, theme/preferences, shared identity, offline edit and recovery backup.
- Postflight found no remaining IntelBoard registration, shortcut, process or ordinary-profile workspace database.

## Fixes retained from Windows testing

NSIS `/D=` must be the final unquoted command-line remainder, including when its directory contains spaces. The updater explicitly quotes the executable path and uses verbatim Windows argument handling with fixed, trusted arguments; no shell is involved.

Windows ASAR listings contain backslashes. Release auditing now normalizes paths for exclusion checks and removes the leading separator before reading content, so those checks actually inspect Windows archive members.

NSIS can restart through Explorer without inheriting the updater test's environment. Only synthetic Windows fixture packages use a dedicated entry point that reconstructs their temporary test profile from the validated fixture installation path. The production package retains `desktop/main.js` and excludes this entry point. Tests verify the versioned uninstall display name and companion installation key, and wait for confirmation transitions before clicking.

## Fedora Linux

Production AppImage packaging and metadata validation, unit checks, desktop/collaboration checks and private/shared canvas regressions passed. Real stable 9.0.0 → 9.0.1 and experimental 9.0.0 → 9.1.0-dev.1 AppImage updates verified the actual downloader, intermediate progress, final save, backup, atomic replacement and restart. They preserved synthetic boards, attachments, theme/preferences, offline collaboration edits and identity. The stable launcher, executable permissions, previous image and original downloaded image were verified.

The seven-file Windows patch was reviewed against the Fedora source, with the incoming full tree verified as `7a84012d135d6b974d3eec0972a2a6c4e7e2c40c`, before integration. The CI workflow repeats native update tests on both platforms before attaching a signed release.

## Limits

Fixture versions are current-source builds with synthetic version numbers. The release API/feed is synthetic and native package downloads use loopback HTTP behind the main-process smoke gate; production still requires approved GitHub HTTPS origins and authentic signatures. These tests do not claim historical updater-free versions can update themselves. Such users need one manual installation of an updater-enabled release.

Power loss, antivirus interference, reputation prompts on other Windows machines, a full live CDN update, long-lived live peer sessions and high-DPI/manual UI acceptance remain outside this automated coverage. Installers are unsigned by Authenticode; Ed25519 update authenticity is separate. No test disables the Electron sandbox, context isolation, signature verification or renderer Node restrictions.
