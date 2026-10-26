# IntelBoard Desktop

A private visual workspace for sources, thoughts, media, and the connections between them. IntelBoard runs on your computer with no account, server, database setup, or development tools required.

- Infinite canvas with pan, zoom, draggable/resizable cards, regions, groups and labeled connections.
- Notes with bold, italic and underline formatting; images, animated GIFs, videos and attachments.
- PDF and EPUB readers with saved reading position and separate notes.
- Link previews, archived source HTML, cached images and YouTube embeds when online.
- Board search, themes, minimap, clipboard operations, undo and redo.
- Local autosave, recovery drafts, native file dialogs and complete portable board/workspace exports.

## Install

Download a release for **Windows 11 x64** or **Fedora Linux x64**. Download installers from [GitHub Releases](https://github.com/ino40k/intelboard-desktop/releases). Initial releases are testing builds; Windows installers are currently unsigned.

**Windows:** run `IntelBoard-<version>-win-x64.exe` and follow the installer. Installation is per user, with Start Menu and optional desktop shortcuts. Unsigned initial builds may show Windows reputation warnings. No administrator account is required for the default installation.

**Fedora:** download `IntelBoard-<version>-linux-x86_64.AppImage`. In the file manager, open Properties → Permissions and allow execution, then launch it. The AppImage uses your system's normal desktop libraries; if FUSE is unavailable, use an AppImage integration tool or extract it with `./IntelBoard-<version>-linux-x86_64.AppImage --appimage-extract` and launch `squashfs-root/AppRun`. No Node.js, database server or Docker is needed. Optional desktop integration is managed by your chosen AppImage tool; IntelBoard does not install a background service.

Updates are manual: install the next Windows installer over the existing installation, or replace the AppImage. Keep the application ID and data folder unchanged. Boards and preferences are stored outside the installation and are preserved.

## Use

Create a board, press **N** for a note, **L** for a link, **R** for a region, or drop files into the canvas. Use the upload button for a native file picker. Pan with **H** or hold Space; press **F** to fit content. Connect cards with **C** or drag a connection handle. Connections mode stays active after each connection; press **Escape**, choose another tool, or toggle the Connect button to exit. The board menu lists keyboard shortcuts and themes. Text editing and canvas editing have separate undo histories, as in the original app.

Changes save automatically. A save error keeps a recovery draft and displays the failure. Wait for file imports/link captures before leaving a board or exporting it. **Export board…** saves a `.intelboard` archive containing the complete board and copies of its attachments. The library offers **Import boards…** and **Export workspace…**. Imports always create separate boards marked “imported”; they never replace existing boards. Workspace exports contain all boards and referenced files, but not recovery drafts, unused attachments or machine preferences. Exports are ordinary unencrypted ZIP files and should be shared only with intended recipients.

Local editing and saved media work offline. Online metadata capture and YouTube need internet access; failures leave the original link usable. Remote sites may refuse embeds or capture. General webpages open in your default browser, matching the original application; source HTML is an attachment, never executed inside the app.

## Your data

Windows: `%APPDATA%/IntelBoard/`. Linux: `${XDG_CONFIG_HOME:-~/.config}/IntelBoard/`.

`intelboard.sqlite` stores boards, items, connections and file references. `assets/` contains imported originals and generated previews. Chromium stores themes and recovery drafts in its user-data subdirectories. SQLite uses transactions, WAL and full synchronous commits. Original files use temporary writes, fsync and atomic rename. A consistent `intelboard.previous.sqlite` database snapshot is retained at startup; it is not a complete attachment backup. Export boards regularly for portable backups. Do not copy only the live `.sqlite` file while the app is open; its WAL may contain recent work. Close the app and copy the entire user-data directory for a full machine backup.

Deleting a board retains uploaded files, matching the original's recoverability behavior. Uninstalling the Windows application leaves user data in place. To deliberately remove your workspace, close IntelBoard and remove its user-data directory yourself.

## Build from source

Use Node.js **24 LTS**, npm, and the standard build tools for your platform. These are developer requirements only.

```sh
npm ci
npx install-electron --no
npm test
npm run build
npm start
```

Package on each target platform:

```sh
npm run package:linux   # Fedora/Linux: release/*.AppImage
npm run package:win     # Windows: release/*.exe
```

`npm run test:desktop` uses synthetic, temporary data and tests persistence across two process launches. Local tests run in a hidden window; Linux CI uses Xvfb, and Windows CI uses its disposable runner desktop. Windows CI also installs the NSIS installer, tests the installed application, and uninstalls it. Tests never open a real workspace. See [validation](docs/VALIDATION.md) for coverage and remaining manual checks.

`npm run audit:release` inspects the Git-tracked source, built frontend and any unpacked application archive. Review its output before distributing a new build. Build outputs and local application data are ignored by Git.

## Releases

GitHub Actions builds Windows and Linux on their own hosted runners for pull requests, main branch changes, version tags and manual runs. Download the resulting build artifacts for testing. Publishing a GitHub release explicitly triggers both builds and attaches the `.exe`, `.AppImage`, native dependency source archive and SHA-256 checksums after validation. Tag pushes alone do not publish a release. No external service, signing secret or auto-update server is required.

Follow [RELEASING.md](docs/RELEASING.md) for versioning, repository setup and publication. Source and releases are hosted at [ino40k/intelboard-desktop](https://github.com/ino40k/intelboard-desktop).

## Architecture and license

Electron bundles Chromium and Node. The original React/React Flow interface and pure application modules are retained; a narrow, validated IPC bridge replaces the Express server. No TCP listener or HTTP backend is started. See [architecture and parity](docs/ARCHITECTURE.md).

MIT, selected by the original code owner. Dependency licenses are retained in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) and in the packaged dependencies; Electron/Chromium includes its own notices. See [licensing](docs/LICENSING.md).
