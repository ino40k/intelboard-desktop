# Maintainer release process

Repository: https://github.com/ino40k/intelboard-desktop. **Get explicit owner authorization before pushing, uploading public artifacts, publishing a release or changing release history.** Public Actions logs and artifacts also count as public uploads. Approval is specific to the release being prepared; do not infer permission for future releases from an earlier publication.

The separate private reference project, local workspaces, logs, test profiles and signing private keys must never be included in this repository or a release.

## One-time updater setup

1. Review source, dependency notices, updater validation and the release privacy audit. Complete Windows 11 and Fedora acceptance tests with synthetic data. Both stable and experimental native update/restart paths have passed on Fedora and a disposable Windows 11 VM; retain that coverage for future changes.
2. The local signing key already exists at `.update-keys/update-private.pem`, ignored by Git. Back it up privately with restrictive permissions. Its public key is embedded in `desktop/updater/trusted-keys.json` (key ID `8e25d18beca56fbd`). Do not regenerate it casually: clients trust the public key shipped in their installed build.
3. **After authorization**, install the private key as a GitHub Actions repository secret. This command sends the file directly and does not print it:

```sh
gh secret set INTELBOARD_UPDATE_SIGNING_KEY \
  --repo ino40k/intelboard-desktop < .update-keys/update-private.pem
```

For a fork/new trust root, `npm run updates:key` creates a new private key and adds its public key; it refuses to overwrite an existing private key. Key rotation requires a bridging release signed with the old key that embeds the new public key before switching CI to the new key. Losing the old key before that transition requires a manual reinstall.

There are no paid services or update servers. GitHub Actions uses its built-in token for asset uploads. Ordinary push/PR builds do not receive the signing secret. The signing job uses Node built-ins only and performs no npm install or dependency lifecycle steps while the secret is present. Maintainer access to this job and its source must be protected.

## Choose the version

- `1.1.0`: a stable feature release; it supersedes `1.1.0-dev.5` and other 1.1.0 previews.
- `1.1.1`: a stable patch fixing 1.1.0.
- `1.2.0`: the next stable feature release.
- `1.2.0-dev.1`, then `.2`: experimental previews before 1.2.0.

The package version and `v`-prefixed Git tag must match exactly. Mark suffixed versions as GitHub prereleases. A GitHub prerelease flag also makes an otherwise stable-looking version experimental, but suffixes are clearer. Never reuse an already signed release version for changed packages. Existing clients never downgrade: a 1.2.0 preview will not offer stable 1.1.1, but will offer stable 1.2.0 when ready.

The first updater-enabled preview is **1.1.0-dev.6**. A release is installable only after its platform assets and signed readiness marker have been uploaded successfully.

## Prepare and validate locally

```sh
npm version 1.2.0-dev.1 --no-git-tag-version
npm ci
npx install-electron --no
npm test
npm run package:linux  # on Linux; builds helper, notices, UI and AppImage
npm run updates:metadata
npm run test:desktop
npm run test:collaboration-ui
npm run test:canvas
npm run test:canvas:shared
npm run updates:fixtures
npm run test:updater-e2e
npm audit --omit=dev
```

On a disposable Windows 11 VM, use `npm run package:win`, run the existing desktop/collaboration/canvas checks, set `$env:INTELBOARD_DISPOSABLE_VM='1'`, then build fixtures and run the native updater test. A real old-to-new Windows test must continue to pass before a new updater release is distributed. See [UPDATER.md](UPDATER.md) for exact test scope and constraints.

Stage only reviewed source, public trust keys, docs, notices and lockfile. Do not stage build outputs, `.update-keys`, test profiles or user data. Run `npm run audit:release` after staging and packaging; it reviews tracked source, frontend and the unpacked application archive. This scanner detects known private/configuration markers, not arbitrary personal prose. Keep `org.intelboard.desktop`, the IntelBoard name and the existing user-data paths unchanged.

## Publish an experimental release — only after authorization

The example assumes the reviewed package version is `1.2.0-dev.1` and release notes are in a reviewed local file. Substitute the actual version consistently.

```sh
git commit -m "Prepare IntelBoard 1.2.0-dev.1"
git tag v1.2.0-dev.1
git push origin main v1.2.0-dev.1
```

Push/tag builds run tests and prepare public Actions artifacts, but do not publish a release or attach installers. Inspect **both operating systems' jobs** before proceeding. Then explicitly publish the prerelease:

```sh
gh release create v1.2.0-dev.1 --repo ino40k/intelboard-desktop \
  --prerelease --title 'IntelBoard 1.2.0-dev.1' \
  --notes-file /tmp/intelboard-release-notes.md
```

This explicit `release: published` event triggers a fresh build and validation of both platforms and the dependency source archive. Packaging always uses `--publish never`. The separate attachment job waits for all required jobs, validates the assets, signs and uploads them. Wait for that job to finish; a visible release page alone does not mean an update is ready.

## Publish stable

After testing the preview, prepare `npm version 1.2.0 --no-git-tag-version`, validate, review and obtain authorization. Commit/tag/push `v1.2.0` as above, then:

```sh
gh release create v1.2.0 --repo ino40k/intelboard-desktop \
  --latest --title 'IntelBoard 1.2.0' \
  --notes-file /tmp/intelboard-release-notes.md
```

Do not use `--prerelease` for stable. Eligible users see green for 1.2.0; its superseded previews disappear. A future 1.3.0-dev.1 can appear separately in yellow. Users may hide yellow notifications in the Updates menu.

## Expected release contents and failure handling

Each signed release contains:

- `IntelBoard-<version>-win-x64.exe` and `.exe.blockmap` when generated.
- `IntelBoard-<version>-linux-x86_64.AppImage`.
- `IntelBoard-<version>-dependency-sources.zip` plus SHA-256 files for the installers and source archive.
- `latest.yml`, `latest-linux.yml`, `experimental.yml`, `experimental-linux.yml`.
- **`intelboard-update.json`**, the signed readiness marker, uploaded **last**.

The four aliases are normalized from electron-builder's actual metadata and checked against the exact packaged SHA-512 and size. They are scoped to each release; runtime channel selection uses the signed release channel and GitHub metadata, so publishing preview aliases does not turn a preview into a stable update. The pinned runtime is electron-updater 6.8.11.

The signing step requires both installers, both platforms' aliases, dependency sources and checksums. The publisher rechecks local bytes, uploads payloads first, reads back GitHub's SHA-256 digests and sizes, and only then uploads the signed marker. Clients ignore a partial release without that marker. Missing secret, failed platform tests, missing packages, corrupt metadata or upload mismatches fail closed.

Before the marker exists, a failed attachment workflow may be rerun after correcting the problem. Once the marker exists, identical reruns are a no-op; changed binaries/markers are rejected. **Bump the version for changes to a signed release.** Never replace executables under a committed marker. Existing release history is not changed by this implementation. With explicit approval, withdrawing an unsafe release can use a title containing `withdrawn`; clients recheck before applying, but this cannot recall an update already installed.

Verify the final release files and then perform an actual updater check from a compatible older updater-enabled installation. Older updater-free versions need one manual install. Windows installers remain unsigned by Authenticode unless separately provisioned; Ed25519 manifests provide project-controlled update authenticity at no certificate cost.
