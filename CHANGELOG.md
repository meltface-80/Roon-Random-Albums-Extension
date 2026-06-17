# Changelog

All notable changes to Roon Random Albums are documented here.

## [1.5.11] — 2026-06-17

### Changed
- **SQLite label database** — the three JSON cache files (`labels-cache.json`,
  `labels-mbid.json`, `labels-logo.json`) are replaced by a single
  `data/cache/labels.db` SQLite database. Writes are immediate and ACID;
  no more debounce timers or risk of partial writes on crash. Existing JSON
  caches are migrated automatically on first startup and deleted.
- **docker-compose.yml** now declares a named `roon-data` volume mounted at
  `/app/data`. Running `docker-compose up -d` is the recommended install/upgrade
  path and guarantees label data is never lost across rebuilds.
- **Dockerfile** installs `python3 make g++` so `better-sqlite3` compiles
  correctly during `docker build`.

### Fixed
- Label database (`data/cache/`) is now correctly preserved by the in-app
  updater's skip list. Upgrading via the settings cog no longer risks losing
  scan results.

## [1.5.10] — 2026-06-17

### Added
- **Label cache persistence** — label name, MusicBrainz MBID, and Fan Art TV
  logo caches are now written to `data/cache/` and excluded from the update
  overlay. Once built, the label database survives in-app updates without
  rescanning.
- **Docker volume for `data/`** — the Dockerfile now declares `VOLUME /app/data`
  and the docker run command mounts a named volume (`roon-random-albums-data`),
  so the cache and Roon pairing persist even when the container is removed and
  rebuilt.

### Changed
- **Fan Art TV logo fetches run 5 at a time** instead of sequentially with a
  500 ms delay. A library with 200 unique labels that all have MBIDs now
  finishes logo fetching in ~8 seconds instead of ~100 seconds.

## [1.5.9] — 2026-06-17

### Added
- **Check for updates** button in the settings cog — tap it to trigger an
  immediate update check without restarting the container.
- **Docker migration banner** — native (non-Docker) installs now see an
  amber banner with copy-ready commands to switch to the Docker version.
  Dismissed permanently once you tap *Got it*.
- `is_docker` field on the `/api/update/status` API response so the UI can
  distinguish Docker from native installs.

### Changed
- **Share card** — fixed height (1200 × 592); release date, album title, and
  artist are now spaced evenly within the cover area. Title and artist both
  wrap up to 3 lines. No review section, no label in the meta line.
- README rewritten as Docker-only. Includes fresh-install steps for v1.5.9,
  upgrade steps from v1.5.8, and native-to-Docker migration instructions.

### Fixed
- In-app updater (`tar` extraction) now works correctly inside Docker/Alpine
  containers — `shell: true` ensures `tar` is found on PATH when the update
  is applied.
- Dockerfile installs `tar` explicitly and sets `ENV DOCKER=1` so the
  migration banner is correctly suppressed for Docker users.

## [1.5.8] — 2026-06-16

Initial Docker release. Packaged as a self-contained `*-docker.tar.gz`
with Dockerfile, all source files, and in-app self-update support via
GitHub Releases.
