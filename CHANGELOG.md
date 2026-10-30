# Changelog

All notable changes to `dsh-everything-file` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.4.3] - 2026-10-30

### Removed

- **The optional third-party index backend and every file that shipped with it**:
  `lib/engine.js` (the client engine), `bin/EverythingBridge.cs`,
  `bin/everything-bridge.exe`, and the bundled `bin/Everything64.dll`, together
  with its attribution in `NOTICE` and `LICENSE`. The package now contains only
  this project's own code (MFT service, portable walk index,
  Spotlight integration) and the operating system's own `mdfind`; no vendor
  library, wrapper executable, or redistributed binary remains.
- Configuration keys `autoStartEverything`, `everythingExe`, and
  `bridgeTimeoutMs`. A profile that still pins `backend: everything` keeps
  working: the value falls back to `auto` and logs one warning.
- Everything-specific query translation from `lib/search.js`
  (`buildEverythingSearch`, the `SORT_*` codes, and the `wfn:` prefix helper).
  The picker's own query grammar (`ext:pdf`, `*.pdf`, path terms, multi-token
  AND) is unchanged.

### Changed

- Windows `backend: auto` no longer probes a third-party client: it uses the
  bundled MFT service when installed and the portable walk index otherwise.
- The model-facing tool keeps its historical name `everything_search` so existing
  prompts and configurations continue to work; it searches through this plugin's
  own backends.

## [0.4.2] - 2026-10-30

### Fixed

- **A query nobody had searched before could never appear, while a query answered
  within the last cache window still did.** `fetchCandidates` aborts the previous
  request *before* it sends the next one, so the picker's repeated asks for one
  text looked like "every caller aborted" and 0.4.1's supersede logic killed the
  only scan that could answer them; the empty result was then cached, which is
  why previously answered words came straight back and new ones never did.
  Requests for the same query now **join the scan already queued or running**
  instead of replacing it, a caller's own abort no longer cancels a scan (only a
  different query or `dispose()` does), and an **empty answer is never cached** —
  a file created a moment later is found by the next keystroke.
- `mdfind` is stopped with `SIGTERM` and only escalated to `SIGKILL` if it
  ignores the request, so an abandoned scan closes its query cleanly in `mds`.

### Documentation

- macOS section now explains what to do when Spotlight itself is incomplete:
  `mdls <file>` returning `(null)` means the file is missing from the system
  index (new files can still be indexed through FSEvents), and
  `mdimport -i <dir>` re-imports a folder without root while `mdutil -E /`
  rebuilds the whole volume.

## [0.4.1] - 2026-10-30

### Fixed

- **macOS `@` completion stalled for seconds and often showed nothing.** Every
  keystroke spawned its own `mdfind`, and since `mds` runs one metadata scan at a
  time the scans queued up behind each other. Typing a word meant the last query
  waited for all previous ones; single letters (`*a*`) and IME pinyin prefixes
  (`c`, `ce`, `ces`) scan a large part of the index, so the final query routinely
  hit the 5 s timeout and returned zero rows — which is why Chinese names
  appeared unreachable while English eventually arrived late. The Spotlight
  backend now keeps one `mdfind` in flight, lets the newest request replace the
  waiting one, and kills the superseded child; the caller's abort signal (the
  picker closing or superseding a request) kills the running scan too. Measured
  on macOS: a `@c e s t 测试` burst went from 5.3 s with four timed-out queries to
  0.46 s with the final `测试` query answered in 138 ms.
- **A single ASCII character now uses a prefix query (`a*`).** `*a*` matches most
  of the index and reliably exceeded the deadline, so pausing after one letter
  produced no list. Chinese single characters keep substring matching (they are
  fast).
- **Accented Latin names were invisible to Spotlight queries.** `mds` stores
  names in the decomposed form; queries now include both NFC and NFD spellings
  and results are compared after NFC normalization.
- **A very common term could exceed the stdout buffer** and fail the whole
  query; scanning now stops as soon as enough rows are collected.

### Added

- **Empty-`@` page on macOS**: recently modified files (Spotlight, last 24 h)
  sorted by modification time, with macOS system, cache, `~/Library`, and
  `~/private` churn filtered out. Previously the empty page was blank on macOS
  while Windows showed recent files.
- macOS noise filters for the recent page (`/system/`, `/library/`,
  `/private/var/`, `/opt/homebrew/`, …).

### Changed

- Spotlight results no longer enter the cache when the lookup was superseded or
  aborted, so deleting a character cannot resurrect an empty list.

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
