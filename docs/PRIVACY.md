# Privacy and distribution audit

## Reference handling

The supplied extracted application was inspected read-only. The new project was constructed with an explicit source allowlist, not a recursive copy. Dependencies were installed from the npm registry into a new dependency tree. No original history was imported. The new repository has independent history. Only the audited desktop source tree is published; its parent directory is excluded.

Excluded categories:

- Environment files, password verifier, authentication/session configuration and proxy settings.
- Private deployment hostnames, addresses, account paths and deployment instructions.
- Docker/Compose files, release overlays, server administration and password scripts.
- Build logs, browser traces, screenshots/test results, caches and generated bundles.
- Original dependency tree, archived bytecode, incremental build metadata and private documentation.
- Original boards, database records, uploaded media and documents; no reference runtime database was found.
- Original binary favicon; the desktop icon was generated from a simple vector mark.

Historical browser traces contained private board/resources and an expired diagnostic session cookie. They are completely excluded. If the reference package was shared outside trusted storage, rotate the original server password because its verifier was present. No credential values are copied into this project or this report. The reference application's security audit is stored privately outside this repository.

## New project boundaries

First launch creates an empty workspace in the operating-system user-data directory. No remote account, telemetry, analytics, startup service or listening server is created. The only intended internet features are user-requested link capture, external browser links and embedded online video. The default browser/provider sees the URLs the user opens. Board exports contain user-selected board content and referenced attachments; they are not encrypted.

`npm run audit:release` scans the Git-tracked source, production frontend and unpacked ASAR paths/content for private environment/deployment/data files and private-network/path/credential markers. Original reference history and parent directories are outside the Git root. The generated artifact is inspected through its extracted ASAR as well. Reinstalled third-party dependencies are reviewed by package inventory and vulnerability/license checks; matching their copyright holder names against personal-data patterns would not be a meaningful privacy check.

No automated scanner can prove the absence of arbitrary private prose. The allowlist construction, source review and synthetic-only fixtures are the main controls. Run the scanner and inspect all newly introduced source/assets before every public release. Hosted Windows installer/runtime verification is documented in VALIDATION.md. Initial installers are unsigned.
