---
name: release
description: This skill should be used when the user wants to create a new release — bump version, tag, push, create GitHub release, and optionally publish to npm. Use when user says "release", "bump version", "publish", "cut a release", or "release candidate".
argument-hint: "[version | rc]"
allowed-tools: Read, Bash(git *), Bash(gh *), Bash(bun *)
---

# Release

Bump version, tag, push, create a GitHub release with auto-generated notes, and present npm publish command. Supports both stable releases and release candidates (RC).

## Inputs

- `$ARGUMENTS` — target version (e.g. `1.15.0`), `rc` for release candidate, or empty for auto-detection.

## Release Type Detection

Determine release type from `$ARGUMENTS` and current branch:
- If `$ARGUMENTS` contains `rc`, or current branch is not `main`/`master` → **RC release**
- If `$ARGUMENTS` is a version like `1.15.0-rc.1` → **RC release** with that exact version
- Otherwise → **Stable release**

## Workflow

### Step 1: Verify Clean Working Tree

Run `git status --short`. If there are uncommitted changes, warn the user and **stop**.

### Step 2: Determine Branch & Release Type

```bash
git branch --show-current
```

- **Stable release**: must be on `main` or `master`. If not, warn and ask to confirm or switch to RC.
- **RC release**: can ship from any branch.

### Step 3: Determine Version

Read current version from `package.json`. If `$ARGUMENTS` is an exact version, use it directly.

**For stable releases:**

Analyze commits since the last stable tag (exclude RC tags) to suggest a bump type:
- **major** — breaking changes
- **minor** — new features (✨ feat commits)
- **patch** — bug fixes, chores, docs only

Present the suggested bump type and resulting version to the user using `AskUserQuestion` with options: patch, minor, major (put the recommended one first with "(Recommended)" suffix).

**For RC releases:**

- If current version is already an RC (e.g. `1.19.0-rc.1`), auto-increment: `1.19.0-rc.2`
- If current version is stable (e.g. `1.18.0`), determine the next minor/patch version and append `-rc.1`
- Present the suggested RC version to the user using `AskUserQuestion` with options showing the auto-incremented version and a "next minor RC" / "next patch RC" alternative.

### Step 4: Bump Version

Update `version` field in `package.json` to the target version.

### Step 5: Commit & Push

```bash
git add package.json
git commit -m "🔖 chore: Bump version to <version>"
git push origin <current-branch>
```

Note: push to the **current branch**, not hardcoded `main`.

### Step 6: Tag & Push Tag

```bash
git tag v<version>
git push origin v<version>
```

### Step 7: Generate Release Notes

Collect commits since previous tag:

```bash
git log --oneline <prev-tag>..HEAD
```

Group by type:
- Features (✨ feat)
- Fixes (🐛 fix)
- Other notable changes

Write concise user-facing notes (not raw commit messages). Include a **Full Changelog** compare link using the repository URL from `package.json`.

### Step 8: Create GitHub Release

**Stable release:**
```bash
gh release create v<version> --title "v<version>" --notes "<notes>"
```

**RC release:**
```bash
gh release create v<version> --title "v<version>" --notes "<notes>" --prerelease
```

### Step 9: Present npm Publish

Show the release URL. Then present the user with the manual publish command:

**Stable release:**
```
npm publish
```

**RC release:**
```
npm publish --tag rc
```

Explain: `--tag rc` prevents the RC from becoming the `latest` dist-tag. Users install via `npm install <pkg>@rc` or `npx <pkg>@rc`.

Do **not** run `npm publish` automatically — let the user decide.
