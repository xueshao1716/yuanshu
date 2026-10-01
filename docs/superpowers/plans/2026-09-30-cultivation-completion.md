# Cultivation completion worklist

2026-10-01 production follow-through: [merge and release evidence](2026-10-01-cultivation-release-results.md).

Approved scope: `../specs/2026-09-30-agent-cultivation-ecology-design.md`.
Implement and verify in `feat/agent-cultivation-ecology`. On 2026-10-01 the user
explicitly authorized completing the work, merging and restarting production.
Preserve unrelated main-worktree changes; inspect merged output before deployment.
No real provider call, enrolled human credential or invented character design.

- [x] Command-bound human grants: host-pinned external public key, expiring
  challenges, opaque sources, revoked/replayed/cross-workspace proof rejected.
  A bearer, local address or model confirmation is never a human identity.
- [x] Shared background admission and budget: preserve the knowledge journal,
  charge cultivation to the same total, additionally enforce cultivation quota;
  durable admission blocks unknown work after restart and foreground has priority.
- [x] Bounded text-task execution: explicit input only, no inherited tools,
  credentials or private context; durable intent before dispatch; uncertain
  effects never automatically replay; cancellation is not assumed completion.
- [x] Knowledge bridge and soil projection: source-role lineage, same-source
  deduplication, no generated user feedback or gene writes; knowledge owns truth.
- [x] A single observation panel: real empty/blocked states, four sections,
  ID-bound appearance/clothing/voice, no hidden polling or duplicate administration.
- [x] Fresh isolated tests, type/build and targeted UI checks; inspect diffs,
  record actual remaining integration gates, and commit only verified changes.

Independent review subsequently completed in `review_cultivation_completion_spec`.
It identified final shared-policy revalidation, command-keyed authorization UI,
and bounded display queries; those fixes and its 52 targeted checks passed.
The earlier empty review transport is not counted as a review.

2026-10-01 focused checks: executor/experience 19/19; browser fixtures at 1440px
and 390px cover empty states, per-agent media isolation, stale drafts, failed
signatures, recovery, overflow and stopped polling after unmount. Performance
fixture: 935 concurrent foreground samples over 60 seconds; additional p95
19.63ms, event-loop p95 42.04ms (limits 100/50ms), shared maximum concurrency 1.
No live provider was used. Screenshot files exist, but visual-content review
was unavailable because the current image tool rejected image input.
Impeccable reports one advisory: intentional 16px editable fields keep mobile
text entry readable; other typography continues using the existing system.

Human enrollment is a deployment requirement: engineering can implement and
test a verification channel with synthetic keys but cannot claim ownership of
a real human authenticator or generate a key and label itself the user.

Final feature-tree verification completed at 2026-10-01T03:49:37.326Z:
3118 tests, 3117 passed, 0 failed, 1 skipped; type checking and isolated build
passed. Browser fixtures were rerun against 2.116.43 at both widths and passed.
Diff whitespace checks passed. Production merge, merged-tree verification,
deployment/restart, installer and remote publication are tracked separately;
these checks alone do not claim a deployed or human-enrolled installation.
