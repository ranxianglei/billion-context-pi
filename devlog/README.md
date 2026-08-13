# devlog/

Development iteration tracking for **billion-context-pi**.

## Purpose

Every development iteration (bug fix, feature, refactor, infra) gets its own folder here. The devlog serves as a persistent, searchable record of what was done, why, and what was learned — complementing git history with structured context.

## Naming Convention

Folder name: `YYYY-MM-DD_short-title`

- Should match the branch name (e.g., branch `2026-08-10_delegate-usage-tracking` → folder `2026-08-10_delegate-usage-tracking/`)
- Use lowercase, hyphens for spaces, no special characters
- Date is the iteration start date
- Backfilled entries (PRs that predate this convention) use the date-based name even when the original branch did not follow the naming convention

## Required Files

Every devlog entry MUST include at minimum:

| File | Purpose | When to fill |
|------|---------|--------------|
| `REQ.md` | Problem statement, acceptance criteria, constraints | **BEFORE** implementation |
| `WORKLOG.md` | Commits, key files, test results, lessons learned | **DURING/AFTER** implementation |

## Optional Files

| File | When to include |
|------|----------------|
| `DESIGN.md` | Required for changes affecting architecture, data flow, or module boundaries |
| `NOTES.md` | Ad-hoc notes, investigation logs, debugging traces |
| `REVIEW.md` | Code review findings (if significant enough to preserve) |

## Rules

1. **Every PR SHOULD have a corresponding devlog entry.** (Strongly recommended; not yet CI-enforced.)
2. The devlog folder name SHOULD match the branch name.
3. At minimum, `REQ.md` and `WORKLOG.md` SHOULD be present.
4. `DESIGN.md` is recommended for any change affecting architecture, data flow, or module boundaries.
5. Fill `REQ.md` **BEFORE** implementation (it functions like a ticket).
6. Fill `WORKLOG.md` **DURING** and **AFTER** implementation.
7. Commit devlog files alongside code changes — not as a separate afterthought.

## npm packaging

`devlog/` is development-only. `package.json` ships a `files` whitelist
(`dist`, `README.md`, `LICENSE`), so the devlog is never included in the
published npm package. No `.npmignore` needed.

## Templates

- [`REQ.template.md`](./REQ.template.md) — Copy to your entry folder as `REQ.md`
- [`WORKLOG.template.md`](./WORKLOG.template.md) — Copy to your entry folder as `WORKLOG.md`
- [`DESIGN.template.md`](./DESIGN.template.md) — Copy when architectural changes are involved

## Directory Layout

```
devlog/
├── README.md                                  # This file
├── REQ.template.md                            # Template
├── WORKLOG.template.md                        # Template
├── DESIGN.template.md                         # Template
└── 2026-08-10_delegate-usage-tracking/        # Backfilled: PR #106 (issue #105)
    ├── REQ.md
    ├── WORKLOG.md
    └── DESIGN.md
```
