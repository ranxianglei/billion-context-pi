# WORKLOG - Update QQ community group in README (EN + ZH)

- Task ID: `2026-09-22_new-qq-group`
- Home Repo: `billion-context-pi`
- Status: Done
- Updated: 2026-09-22 13:10

## 1. Summary

- **What was done**: Updated the "Community"/"社区" section in both `README.md` and `README.zh-CN.md` to list the new shared QQ group (`1108730198`) as the group to join, while keeping the original group (`1056132097`) visible and marking it full.
- **Why**: The original group reached its member cap; a new group was created. Users asked for the same update to be applied across all three sibling project READMEs, keeping the original group listed (not removed) and just noting it is full.
- **Behavior / compatibility changes**: No — documentation only.
- **Risk level**: Low

## 2. Change Log

### Key Files

- `README.md` — updated `## Community` section: new group `1108730198` primary; original group `1056132097` retained on its own line, noted as full.
- `README.zh-CN.md` — updated `## 社区` section: new group `1108730198` primary; original group `1056132097` retained on its own line, noted as full.

## 4. Testing & Verification

### Results

- **PASS/FAIL**: PASS (docs-only; no build/test needed)
- Verified diff touches only the two README files (+ devlog); `package.json` version untouched. Both group numbers remain visible in every language section.

## 5. Risk Assessment & Rollback

- **Risk points**: None functional.
- **Rollback method**: Revert the commit(s).
- **Compatibility notes** (data format, config schema): No.
