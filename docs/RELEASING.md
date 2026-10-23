# Maintainer release process

The desktop repository is https://github.com/ino40k/intelboard-desktop. The owner authorized public source and testing releases. The private reference source is outside this independent repository. Never add it, its environment/configuration, logs, traces or generated history.

## Initial repository setup

1. Review this source, validation report, dependency notices and the final release privacy audit.
2. On Windows 11 and Fedora, run the manual acceptance checks in VALIDATION.md with synthetic data.
3. Create an empty GitHub repository. Do not upload the parent workspace or original reference project.
4. From this desktop repository, make a clean initial commit, then connect the approved remote:

```sh
git commit -m "Create standalone IntelBoard Desktop"
git branch -M main
git remote add origin https://github.com/OWNER/REPOSITORY.git
git push -u origin main
```

Replace OWNER/REPOSITORY with the repository you approved. These commands describe the initial setup for forks; the main repository is already connected. GitHub Actions uses the built-in GITHUB_TOKEN and normal hosted Windows/Ubuntu runners; no personal token is stored in the repository.

## Each version

1. Bump the semantic version consistently with `npm version patch --no-git-tag-version` (or minor/major); commit package.json and package-lock.json together.
2. Run `npm ci`, `npx install-electron --no`, `npm test`, `npm run build`, `npm run test:desktop` and platform packaging. Audit installed production dependencies and retain the lockfile. Build tools require internet; ordinary app operation does not.
3. Review `npm run audit:release` after packaging. Inspect the actual installer contents and license files. The scanner is a guard against known private/configuration markers, not a guarantee that arbitrary personal prose can be detected.
4. Commit changes, create a matching version tag and push only when publication is authorized:

```sh
git tag v1.0.0
git push origin main v1.0.0
```

5. The tag build uploads private-to-repository Actions artifacts for validation; it does not create a release. Inspect both OS results and perform acceptance tests.
6. Explicitly publish a GitHub Release for the matching tag. The release event rebuilds both platforms and attaches the installer/AppImage after both matrix jobs pass. Allow the workflow time to finish. Download the final files and verify checksums before sharing them.

CI uses `--publish never` for packaging. The only external upload of installers is the separate release-attachment job, which runs only for an explicitly published release. A failed build leaves the release without complete attachments; fix it and rerun rather than assuming a release page means successful binaries.

Initial Windows installers are unsigned. Code signing can be added with repository-environment secrets later; no signing credentials are required or included now. Do not disable Electron's Chromium sandbox to work around a host configuration problem. Future updates must preserve `org.intelboard.desktop`, the IntelBoard application name/user-data path, and data schema compatibility.
