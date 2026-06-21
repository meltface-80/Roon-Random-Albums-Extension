# Claude Code — Project Rules for Roon Random Albums Extension

Read this file at the start of every session. These rules are permanent and override any
default behaviours. Do not deviate from them unless the user explicitly says so in that session.

---

## ZERO-TOLERANCE QUALITY MANDATE

**Regressions are not acceptable. Bugs introduced by a change are a failure, not a follow-up task.**

### Mandatory pre-flight before every commit

Run these in order. Do not commit if any step fails.

```bash
# CLAUDE.md - Mobile-First Zero-Tolerance Quality System

## Core Mandate
- ZERO regression allowed. Every bug fix must include a corresponding test.
- ZERO blind-merging. Never output partial layouts or say "this will do."
- ALWAYS run automated tests before asking for mobile user validation.

## Mobile Agent Workflow (Remote Control Loop)
When executing prompts via the iOS app, Claude must act as a multi-agent loop:
1. **Architect Agent**: Scan files, map side effects, and verify changes won't break mobile rendering.
2. **Reviewer Agent**: Ensure the change handles edge cases, empty states, and errors safely.
3. **Developer Agent**: Apply complete, production-grade code. No inline placeholders (`// ...`).
4. **QA Agent**: Execute the exact build/test commands, verify pass status, and cleanly format the results.

## Push Notification Triggers
- Use the mobile push notification channel proactively (`/config` notification settings).
- Send a high-priority push notification IMMEDIATELY when:
  * A long-running test suite finishes or errors out.
  * An architectural blocker requires a strict design decision.
  * Code has passed all QA checks and is ready for mobile review.
- Tag notifications clearly: `[PASS] Ready for review` or `[FAIL] Test Error on Line X`.

## Compact Operational Commands
Keep output text compact to prevent excessive scrolling on small iOS displays.
- Install Dependencies: [Insert e.g., `npm install` or `pod install`]
- Run Type Checks: [Insert e.g., `npm run lint` or `swiftlint`]
- Execute Test Suite: [Insert e.g., `npm test` or `xcodebuild test`]
- Auto-Fix & Format: [Insert e.g., `npx prettier --write .` or `swiftformat .`]

## Anti-Regression & Fail-Safe Guardrails
- **Fail Fast**: If a test fails, halt immediately. Do not guess or continue writing features.
- **Strict Layout Constraints**: Never let UI changes break standard responsiveness or overflow mobile views.
- **Forbidden Patterns**: Never rewrite `.pbxproj` or core project configuration files unless explicitly directed. Use isolated source code files.
```

If step 3 cannot run (Roon not available), run steps 1 and 2 and explicitly note why 3 was skipped.

### Pre-flight checklist (tick each before every push)

- [ ] `node --check index.js` exits 0
- [ ] No `let x` declared after a bare `x = ...` assignment at module scope
- [ ] Every variable referenced matches its exact declaration name (no UPPER_SNAKE drift)
- [ ] Every new `catch (e) {}` is intentional — not swallowing a symptom
- [ ] Auth headers reference the live variable, not a deleted constant
- [ ] Any new HTML element ID matches the `getElementById` call in app.js exactly
- [ ] `package.json` version bumped
- [ ] CHANGELOG.md entry added

### Development rules

- **No incomplete implementations.** Write the full code. Never leave `// rest stays the same`.
- **No silent catch.** `catch (e) {}` must have a comment explaining why silence is safe.
- **Variable name freeze.** Once a variable is named, all references — declaration, assignment, template literals, log messages — use the identical name. Never mix camelCase and UPPER_SNAKE for the same value.
- **Declaration before use.** With `let`/`const` in Node.js, a bare assignment `x = val` on line N while `let x` is on line N+500 is a ReferenceError. Always declare at the first-use site.
- **No partial migrations.** When renaming a constant or moving it to settings, search the entire file with grep before committing to ensure zero stale references remain.

### When a bug is found

1. Identify the root cause (not the symptom).
2. Confirm the root cause explains ALL reported failures.
3. Fix the root cause, not the symptom.
4. Add the relevant pre-flight check above if one would have caught it.
5. Document what class of error it was in the CHANGELOG.

---

## Code review workflow (multi-agent)

For any non-trivial change, run a full code review using parallel agents before committing. The `/code-review --effort high` skill automates this. It must be run on any change that touches:
- The label scan pipeline (`runLabelsIndexScan`, `buildFileLabelMap`, pass logic)
- Discogs or FanArt.tv API integration
- Settings persistence (`savePersistedSettings`, `loadPersistedSettings`)
- New UI components in `public/app.js` or `public/index.html`

### Review angles (run in parallel via Agent tool)

Spawn all 8 angles simultaneously, then verify surviving candidates:

| Angle | What it hunts |
|-------|---------------|
| A — line-by-line diff scan | Inverted conditions, null deref, missing await, wrong variable |
| B — removed-behavior auditor | Dropped guards, deleted error paths, narrowed validation |
| C — cross-file tracer | Broken call sites, mismatched request/response shapes |
| D — reuse | Code that re-implements an existing helper |
| E — simplification | Redundant state, dead code, unnecessary nesting |
| F — efficiency | Sync I/O on hot paths, redundant computation |
| G — altitude | Bandaids layered on shared infrastructure |
| H — CLAUDE.md conventions | Quote the exact rule and exact violating line |

### Verify findings

For each surviving candidate, spawn one verifier agent and get: **CONFIRMED / PLAUSIBLE / REFUTED**.
- PLAUSIBLE by default — do not refute without quoting code that proves it impossible.
- REFUTED only when the code provably makes it unreachable.
- Keep CONFIRMED and PLAUSIBLE. Drop REFUTED.

### Fix all confirmed findings before committing

Do not commit with known CONFIRMED or PLAUSIBLE bugs. Fix them all in the same version bump.

---

## Repository

- Work directly on the **main branch** of `meltface-80/Roon-Random-Albums-Extension`.
- **Never use a feature branch.** Never create a pull request.
- The `old/` folder contains two permanent historical tarballs (v1.5.37 and v1.5.49). **Do not add to or remove from this folder.**

---

## Every build — required steps (in order)

1. Make code changes
2. Bump `package.json` version
3. Add a CHANGELOG.md entry (see format below)
4. Commit the three changed files in a single commit: code + `package.json` + `CHANGELOG.md`
5. Push to main

**Do not build or commit a tarball.** GitHub Actions builds it automatically on push and
uploads it as a release asset. The tarball is only ever in the GitHub release, never in the repo.

---

## GitHub releases — ALWAYS pre-release

The GitHub Actions workflow (`.github/workflows/release.yml`) creates a release on every
push. It is configured with `--prerelease`. **Do not remove that flag.**

- Every build goes out as a **pre-release**. GitHub will NOT mark it as latest.
- The user manually promotes a release to "latest" when satisfied with testing.
- **Never manually create a release or change the latest/pre-release status yourself.**

---

## README.md — frozen until told otherwise

- The README contains version references (install commands, tarball URLs, `docker build` tags).
- **Do not change any version number in README.md** unless the user explicitly says
  "promote to latest" or "update the README".
- Current stable version in the README: **v1.5.49** (until the user says otherwise).

---

## CHANGELOG.md format

Add a new section at the top, above the previous version:

```
## [X.Y.Z] — YYYY-MM-DD

### Added / Fixed / Changed
- Description of change
```

---

## After each build — give the user the full docker command

Always provide the full rebuild command with the new version, ready to copy-paste:

```bash
sudo docker stop roon-random-albums
sudo docker rm roon-random-albums
sudo rm -f /opt/roon-random-albums/roon-random-albums-vPREVIOUS-docker.tar.gz
cd /opt/roon-random-albums
wget https://github.com/meltface-80/Roon-Random-Albums-Extension/releases/download/vNEW/roon-random-albums-vNEW-docker.tar.gz
tar -xzf roon-random-albums-vNEW-docker.tar.gz
docker build -t roon-random-albums:NEW .
docker run -d \
  --name roon-random-albums \
  --restart unless-stopped \
  --network host \
  -v roon-random-albums-data:/app/data \
  -v /mnt/dietpi_userdata/4tb/Music:/music:ro \
  roon-random-albums:NEW
```

---

## Current version history (for reference)

| Version | Status    | Notes                              |
|---------|-----------|------------------------------------|
| v1.5.37 | stable (superseded) | Previous README stable          |
| v1.5.38 | stable (superseded) | File scanner layout fix          |
| v1.5.39 | stable (superseded) | Rate limiting, MB timeout, misc  |
| v1.5.40 | stable (superseded) | iTunes rate limiting, file cache |
| v1.5.41 | stable (superseded) | Scan logging, 12h auto-rescan    |
| v1.5.42 | stable (superseded) | Progress tracking, circuit breaker |
| v1.5.43 | stable (superseded) | Progress bar >100% fix             |
| v1.5.44 | stable (superseded) | Label name text tiles              |
| v1.5.45 | stable (superseded) | Remove album-art fallback from label tiles |
| v1.5.46 | stable (superseded) | Label text size by longest word not word count |
| v1.5.47 | stable (superseded) | Consistent label text size via container query (8cqw) |
| v1.5.48 | stable (superseded) | Label text size increased to 9cqw |
| v1.5.49 | **Latest (stable)** | Discogs label logo fetches — README points here |
