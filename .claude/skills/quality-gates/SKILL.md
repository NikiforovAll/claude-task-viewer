---
name: quality-gates
description: Run code quality checks on the claude-code-kanban project. Use this skill whenever the user wants to check code formatting, linting, or overall code quality for the public/app.js and public/style.css files. Trigger on phrases like "check quality", "lint", "format check", "style check", "quality gates", or any mention of code quality/standards.
compatibility: Requires Node.js 18+, npx available
allowed-tools: Bash(npx @biomejs/biome *)
---

# Quality Gates Skill

Run Biome to check formatting and linting issues in the claude-code-kanban codebase.

## What This Does

Checks `public/app.js` and `public/style.css` using Biome for:
- **Formatting issues** — indentation, spacing, line length
- **Linting issues** — code quality, potential bugs, style violations
- **Reporting** — clear summary of what needs fixing

## Usage

Report issues (no changes):

```bash
npx @biomejs/biome check public/app.js public/style.css
```

Apply safe auto-fixes:

```bash
npx @biomejs/biome check --fix public/app.js public/style.css
```

Apply all fixes including unsafe ones (template literals, etc.):

```bash
npx @biomejs/biome check --write --unsafe public/app.js public/style.css
```

Format only (no linting):

```bash
npx @biomejs/biome format --write public/app.js public/style.css
```

## Output Format

Biome will report:

```
✖ <file>
  <line>:<col> <rule> <message>
```

Pay attention to:
- `error` (must fix)
- `warn` (should fix)
- Formatting violations (indentation, whitespace)
- Code quality issues (unused variables, potential bugs)

## Example

Recent run found:

**public/app.js:**
- 8 errors (regex issues, assignment in expressions)
- 50 warnings (string concatenation vs templates, unused escapes)
- 32 infos (redundant 'use strict', style issues)

**public/style.css:**
- 7 warnings (descending CSS specificity selectors)

Issues are marked as `FIXABLE` when Biome can auto-correct them.

## How to Fix

1. Run `npx @biomejs/biome check --fix` for safe fixes first
2. Review remaining issues and decide on unsafe fixes
3. Re-run check to verify all issues are resolved
