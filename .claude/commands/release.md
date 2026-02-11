---
description: Bump version, tag, push, and create a GitHub release with auto-generated notes
argument-hint: "[version e.g. 1.13.0]"
---

# Release

Create a new release for this project.

## Inputs

- `$ARGUMENTS` — target version (e.g. `1.13.0`). If not provided, ask the user.

## Steps

1. **Determine version**: Use `$ARGUMENTS` or ask user. Validate it's greater than the current version in `package.json`.

2. **Check working tree**: Run `git status`. If there are uncommitted changes, warn the user and stop.

3. **Bump version**: Update `version` in `package.json` to the target version.

4. **Commit & push**:
   ```
   git add package.json
   git commit -m "🔖 chore: Bump version to <version>"
   git push origin main
   ```

5. **Tag & push tag**:
   ```
   git tag v<version>
   git push origin v<version>
   ```

6. **Generate release notes**: Collect commits since the previous tag using `git log --oneline <prev-tag>..HEAD`. Group by type:
   - Features (✨ feat)
   - Fixes (🐛 fix)
   - Other notable changes
   Write concise user-facing notes (not raw commit messages). Include a "Full Changelog" compare link.

7. **Create GitHub release**:
   ```
   gh release create v<version> --title "v<version>" --notes "<notes>"
   ```

8. **Report**: Show the release URL to the user.
