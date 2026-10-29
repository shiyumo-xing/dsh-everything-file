# Changelog

All notable changes to `dsh-everything-file` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- GitHub Actions CI (Linux, macOS, Windows) and a tag-driven release workflow.
- **Code signing pipeline**:
  - Authenticode signing of the Windows binaries through the
    `WINDOWS_SIGNING_PFX_BASE64` / `WINDOWS_SIGNING_PFX_PASSWORD` secrets
    (`scripts/sign-windows.ps1`);
  - keyless Sigstore `cosign` signature over the release checksum manifest;
  - GitHub artifact build attestation;
  - npm provenance on publish;
  - GitHub Release assets (npm tarball, Windows binaries, checksums, signature bundle).
- `CHANGELOG.md`, `LICENSE`, repository/author metadata, and publish configuration.
- Windows service installer now copies the indexer to
  `%ProgramData%\dsh-mft-index\` before registration, so plugin upgrades cannot
  leave the service pointing at a replaced package file.

## [0.4.0] - 2026-10-30

### Added

- **Portable walk index** (`lib/local-index-worker.js`) that runs in a worker
  thread on Windows, macOS, and Linux with no administrator rights, no native
  binary, and no external index. Names are stored in chunked buffers and queried
  with native `Buffer.indexOf`; the index streams results while it is still
  being built.
- **macOS Spotlight backend** (`lib/spotlight-engine.js`) using `mdfind`, with
  extension filters, path queries, result validation, and caching.
- **Per-platform `backend: auto`**:
  Windows → optional MFT service → running Everything → portable walk index;
  macOS → Spotlight → portable walk index; Linux/other → portable walk index.
- New config keys `localRoots`, `localExcludeRoots`, `localMaxEntries`,
  `localRefreshMinutes`, and `backend: local`.
- `mft_index_status` now reports the active backend, MFT service, Spotlight, and
  portable-index build progress.

### Changed

- The plugin is usable on a clean machine with no Everything installation and no
  elevation; the portable index builds in the background and answers partially
  built indexes.
- Exposed `everything_search` tool and `@` completion share the same backend
  selection and ranking.

### Fixed

- Portable index path queries now normalise `/` and `\` separators and skip the
  name-token filter in path mode.
- Spotlight path mode no longer requires the full path to match the file name.
- Provider `list()` no longer touches private class members, which failed the
  Cordis service proxy brand check and silently returned no `@` candidates.

## [0.3.0] - 2026-10-29

### Added

- **USN journal incremental updates** in the Windows MFT service: creates,
  renames, hard-link changes, and deletes are applied to a small overlay within
  roughly 0.4–1 s, instead of waiting for a periodic rebuild.
- Full rebuild is now rare (journal wrap/id change, overlay > 150k rows, or a
  six-hour compaction interval) and runs at `BelowNormal` priority with
  cooperative sleeps, while queries keep using the previous snapshot.
- macOS Spotlight backend and platform-aware backend selection.

### Fixed

- Rebuilds replay journal records from the pre-build USN position, so changes
  made during a scan are not lost.

## [0.2.0] - 2026-10-29

### Added

- **Bundled NTFS index service** (`dsh-mft-index`, .NET Framework):
  `FSCTL_ENUM_USN_DATA` MFT scan of every fixed NTFS volume, in-memory index,
  named-pipe protocol (`QUERY`/`RECENT`/`STATUS`/`REBUILD`), install/uninstall
  scripts, and the `mft_index_status` tool.
- Windows installer registers the service as LocalSystem, runs it at boot, and
  keeps the Harness process unprivileged.

## [0.1.0] - 2026-10-29

### Added

- Initial `@file` provider replacement for the workspace-only
  `dsh-file-reference-local`.
- Everything-backed discovery over a persistent bridge: empty-query recent
  files, directory listings for path queries, global name search with local
  relevance ranking, extension filters, and the `everything_search` tool.
- Localized plugin metadata and icon.
