# 元枢知识自动运行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Steps use checkboxes for tracking. User has already authorized implementation; do not repeat the design approval gate.

**Goal:** Run a recoverable, evidence-backed knowledge pipeline without weakening chat reliability, privacy, budgets, or existing approvals.

**Architecture:** Compose focused injected modules around the existing run ledger and learning intake. A workspace-local fenced store owns jobs, policy, budget, entries and commit journals; a single low-priority worker uses safe source and provider adapters. Authenticated APIs expose that same state to the existing knowledge page and read-only soul summary.

**Tech Stack:** Node ESM, node:test, filesystem atomic writes and existing cross-process locks, React/TypeScript/SWR, existing model catalog and directChat adapter.

## Actual execution ledger (2026-09-30)

- [x] Tasks 1–5: durable queue, source/evidence fencing, persistent budgets, worker/retrieval and authenticated runtime integration implemented and tested.
- [x] Task 6: knowledge controls and summary-only soul integration; desktop/mobile isolated browser acceptance and frontend detection passed.
- [x] Task 7: isolated end-to-end/security/recovery coverage; full suite 2966 passed / 0 failed / 1 Windows EPERM skip, types/build passed; exclusive 60s performance gate passed.
- [x] Independent specification and code-quality reviews completed; startup import and stale retrieval-status findings reproduced, fixed and independently closed (33/33 focused tests).
- [x] Task 8: scoped integration and main-build verification completed; release `60abcb19` deployed as `2.116.41`, live knowledge APIs returned 200, three asset entrypoints/157 reachable files checked, and release pushed to both remotes. Direct process-stop access denial was resolved through the existing watchdog scheduled-task stop/start API; unrelated portrait/theme edits and the mesh listener were preserved. Final documentation refs and delivery notification are checked at handoff.

The detailed checkboxes below preserve the original proposed sequence, not a fabricated execution log. The planned per-task commits were not made; delivery is being split into coherent reviewed source/UI/release commits instead. Acceptance evidence and limitations are in `../reports/2026-09-30-knowledge-autonomy-verification.md`.
Actual retrieval context uses a conservative 2000 UTF-8-byte cap; method proof uses an explicitly authorized artifact-bound `json-contract-v1` validator. The final synchronous `retrievalCurrent` fence also checks current authoritative entry status and source identity.

## Execution rules

- Worktree: `D:/pi-web/.worktrees/knowledge-autonomy`, branch `feat/knowledge-autonomy`, base `5ef92c8b`.
- Preserve all main-worktree portrait/theme changes. Do not mutate production workspace or enable external calls while testing.
- Each test creates an `os.tmpdir()` fixture. Targeted tests: `node --test tests/unit/knowledge-*.test.mjs`; integration tests use `verificationEnvironment` and preload. Full acceptance: `npm run verify`.
- TDD for every task, then independent specification review, then code-quality review. Keep modules around 200 lines, split by responsibility.
- APIs below return detached JSON. Mutations throw errors with stable `code` and no private content. Clock/transport/store/foreground state are injectable.

### Task 1: Durable store, policy, fencing and journal

Files: create `engine/knowledge-store.mjs`, `engine/knowledge-state.mjs`, `engine/knowledge-policy.mjs`, `engine/knowledge-commit.mjs`, `tests/unit/knowledge-store.test.mjs`, `tests/unit/knowledge-commit.test.mjs`.

- [ ] Write failing tests for idempotent enqueue, separate workspace/session/version/event identities, revision conflicts, two simultaneous store instances claiming one task, expired leases, policy revocation, paused/cancelled recovery, corrupted storage and crash after entry write.
- [ ] Run `node --test tests/unit/knowledge-store.test.mjs tests/unit/knowledge-commit.test.mjs`; expect missing-module failure before implementation.
- [ ] Implement these contracts with short cross-process transactions, atomic files and deterministic SHA256 IDs:
```js
createKnowledgeStore({ wsRoot, now = Date.now, leaseMs = 90_000, fault })
// async: policy(), updatePolicy(patch, expectedRevision)
// async: enqueue({sourceId, sourceVersion, event, runId, sessionId, parentRunId, sources, title})
// async: get(id), list({offset=0, limit=20}), summary()
// async: claim(owner), transition(id, guard, patch), control(id, action, expectedRevision)
// guard = {revision, generation, owner, policyRevision}; lease expiry is also checked
// async: commit(id, guard, entry), recover(), entries(), recordUse(entryId, feedback)
// deterministic entry ID = sha256(workspace + job.id + sourceVersion)
```
Policy defaults: local enabled, remote/network disabled, dailyCost=0 USD, concurrency1, model/network request limits20, input6000/output1200 tokens, allowedRoots empty, allowedUrls empty, allowedModels empty, model empty; revision1. Local run references require explicit eligible-run adapter later. Paused policy prevents claims and commits. Job state and stage separate. Terminal jobs are retained, never dropped for capacity. Journal contains entry and intended completion; recover validates hashes and authorization before repairing state. Reserve fields for budget/evidence without granting them authority.
- [ ] Rerun tests, inspect detached outputs and lock cleanup, commit only task files with `feat: persist fenced knowledge tasks and commit recovery`.

### Task 2: Safe local sources and evidence validation

Files: create `engine/knowledge-sources.mjs`, `engine/knowledge-evidence.mjs`, `tests/unit/knowledge-sources.test.mjs`, `tests/unit/knowledge-evidence.test.mjs`.

- [ ] Write red tests for traversal/junction escapes, auth/personality exclusions, 1MiB and five-source limits, changed/revoked hashes, exact versus fabricated excerpts, synthesis candidate, failure observation, conflict and method proof.
- [ ] Run both files with `node --test`; expect imports to fail.
- [ ] Implement explicit contracts:
```js
collectLocalSources({wsRoot, sources, policy, runStore}) // async snapshots {id, kind, locator, hash, text, fetchedAt}
extractLocal(snapshots, job) // exact attributed bounded excerpt; never title-as-body
validateCandidate({candidate, snapshots, job, entries, now, checks=[]})
// {state:'ready'|'blocked'|'review_required'|'skipped', reason, entry?}
```
Resolve real paths under canonical allowed roots; current-run references must match persisted request attachments. Exclude credentials, private config, protected personality and knowledge-generated paths. Snapshots preserve SHA256 and locator, not full conversations. Exact excerpts become attributed source material, not verified facts; synthesized conclusions remain review_required. Verified methods require referenced actual artifact hashes and allowlisted objective check results (never model PASS). Conflicts preserve both and invalidate normal retrieval. Source updates/revocation invalidate prior entries. Runtime facts expire7days, others30days.
- [ ] Run tests to green and commit `feat: validate authorized knowledge sources and evidence`.

### Task 3: Persistent budget and controlled external adapters

Files: create `engine/knowledge-budget.mjs`, `engine/knowledge-provider.mjs`, `engine/knowledge-fetch.mjs`, tests with matching names; minimally extend `engine/model-client.mjs` with an explicit no-fallback option and its regression test.

- [ ] Red tests: zero budget, unknown price, explicit free model, concurrent reservations, missing usage, every retry charged, UTC rollover/backwards clock, model failure, private DNS/rebinding/redirects, oversized bodies, no cookies or credentials.
- [ ] Run `node --test tests/unit/knowledge-budget.test.mjs tests/unit/knowledge-provider.test.mjs tests/unit/knowledge-fetch.test.mjs`.
- [ ] Implement contracts:
```js
createKnowledgeBudget({wsRoot, now}) // reserve({kind, policy, maxCost, currency, id}), settle(id, usage), status()
createKnowledgeProvider({catalog, directChat, budget}) // extract({job,snapshots,policy,signal})
fetchKnowledgeSource({url, policy, budget, signal, lookup, transport})
```
Use UTF8 byte count as conservative token upper bound including all system/JSON framing; explicitly reject unbounded model tokenizers. Reserve every actual network/model request before transport. directChat uses selected enabled text model only, `timeout:60000`, `allowPartial:false`, `throwOnError:true`, no hidden404 fallback. No guessed price; explicit per-million input/output prices or explicit free rate. Missing usage retains full reservation. Persist UTC day high-water mark. HTTPS URL exact allowlist; validate DNS every hop and pin public address, max redirects3, no credentials/cookies, body cap1MiB, timeout15s. Parse fetched content as data, strip active content.
- [ ] Green tests and commit `feat: enforce knowledge request budgets and safe transports`.

### Task 4: Worker, migration, retrieval and real feedback

Files: create `engine/knowledge-worker.mjs`, `engine/knowledge-intake.mjs`, `engine/knowledge-retrieval.mjs`, `tests/unit/knowledge-worker.test.mjs`, `tests/unit/knowledge-intake.test.mjs`, `tests/unit/knowledge-retrieval.test.mjs`; modify `engine/learning-intake.mjs` to remove pending retirement.

- [ ] Red tests cover complete local chain, failed observation, migrated missing source blocked, source idempotency, self-output exclusion, only20 reconciled per pass, no foreground heavy step, retry1m/5m+jitter, circuit30m after3 transient failures, no auth/payment retry, restart/journal completion, scoped retrieval exclusions and feedback not becoming acceptance.
- [ ] Run the three new tests and existing learning-intake tests in isolated environment.
- [ ] Implement:
```js
createKnowledgeWorker({store, collect, extract, validate, foregroundBusy, now, random})
// tick(), wake(reason), start({startupMs=120000,intervalMs=60000}), stop()
createKnowledgeIntake({wsRoot,runStore,store,legacyFile}) // enqueueRun(run), reconcile({limit=20})
createKnowledgeRetrieval({store,verifySource,now}) // retrieve({query,sessionId,runId,maxEntries=5,maxTokens=2000})
```
No network inside enqueue or GET. Migration first saves immutable old-index backup; missing actual run body never reconstructed from title. New failed/completed runs use persisted actual input/checkpoint/output artifacts, not broad session scans. Foreground preempts new heavy stages, cancellation aborts inflight signals, policy rechecked at commit. Retrieval cached index refreshed outside chat path, max5/2000tokens, source validity checked; failure yields visible unavailable status but does not block chat. Usage stores genuine run/session refs, separate from pass/fail/human approval. Source revalidation events do not recursively collect their generated knowledge output.
- [ ] Green tests and commit `feat: run recoverable knowledge collection and scoped reuse`.

### Task 5: Authenticated API and service integration

Files: create `engine/knowledge-api.mjs`, `engine/knowledge-runtime.mjs`, `tests/unit/knowledge-api.test.mjs`, `tests/unit/knowledge-runtime.test.mjs`; modify `server.mjs`, `engine/chat-voice-admission.mjs` and relevant tests; inspect export exclusions.

- [ ] Red tests verify unauthenticated writes401, stale revision409, readonly GET, invalid model/policy400, paginated jobs, authenticated policy/control/manual enqueue, foreground voice count, no personality/genome/team writes, private knowledge excluded from export.
- [ ] Implement API and composition contracts:
```js
createKnowledgeApi({runtime,readBody,json,requireAuth})
// GET /api/knowledge/status, /api/knowledge/jobs, /api/knowledge/jobs/:id, /api/knowledge/policy
// POST /api/knowledge/policy {revision,patch}; /api/knowledge/jobs/:id/control {revision,action}
// POST /api/knowledge/enqueue {revision,source}; manual source goes through same intake validation
createKnowledgeRuntime({wsRoot,runStore,catalog,directChat,foregroundBusy})
// store, worker, intake, retrieval, api-facing summary; no separate general agent
```
Wire onRunFinished without dropping old intake; failures are isolated/reportable. Startup after120s, interval60s unref and teardown cleanup. Task-scoped source-attributed context uses current message/run/session, not global last query. Voice admission adds `isActive()` read-only count. Read-only projection to aibody/soul; existing team artifact references retain review metadata without triggering new teams or claiming accepted output. GET never starts worker. Do not start production during tests.
- [ ] Green targeted tests and commit `feat: connect knowledge runtime to task lifecycle`.

### Task 6: Knowledge control center and single-source soul summary

Files: create `frontend/src/knowledge/KnowledgePanel.tsx`, `KnowledgePolicy.tsx`, `KnowledgeJobs.tsx`, `frontend/src/knowledge/api.ts`; modify `frontend/src/components/LearningIntakePanel.tsx`, `frontend/src/pages/Apps.tsx`, `frontend/src/soul/LiveSections.tsx`; add `tests/unit/knowledge-ui.test.mjs`.

- [ ] Read relevant frontend design skill and existing neighboring components. Write source-contract red tests for hidden-page polling disabled, error visible, distinct states, revisioned controls, enabled text catalog, authorization/cost disclosure, legacy history preservation and soul summary-only link.
- [ ] Implement paginated status/jobs, selectable detail, guarded pause/resume/cancel, settings for selected knowledge model/explicit rates/currency/cost/roots/URLs/outbound scopes and remote/network toggles default OFF. Show missing authorization/rate/usage honestly. Manual extraction uses new enqueue API; old proposal history/actions remain. Voice/portrait controls untouched.
```ts
type KnowledgeJob = { id: string; state: string; stage: string; revision: number; reason?: string; nextAttemptAt?: number };
// SWR {refreshInterval:30000, refreshWhenHidden:false}; page size20, selected detail fetched on demand.
```
- [ ] Run contract tests, TypeScript, nonproduction build and Impeccable detect on changed files; isolated browser fixtures at desktop/mobile widths with no real paid requests. Commit `feat: surface knowledge automation and authorization controls`.

### Task 7: End-to-end resilience and performance acceptance

Files: create `tests/unit/knowledge-e2e.test.mjs`, `scripts/verify-knowledge-performance.mjs`, `docs/superpowers/reports/2026-09-30-knowledge-autonomy-verification.md`.

- [ ] Run temp-workspace end-to-end source → entry → next-task citation → usage feedback; inject failures at every stage/commit boundary and run two process claims. Exercise denied path/redirect/prompt injection/model budget0, changed policy/source during call, provider429/payment failure and unknown usage.
- [ ] Compare at least100 foreground requests baseline versus worker with fixed provider; measure additional p95≤100ms. Stress for60s and event-loop p95≤50ms. Save machine/conditions/raw measurements to ignored tmp output, summarize report without private data.
- [ ] Run `npm run verify`, detect and independent whole-change specification/code review. Distinguish mock provider from unperformed authorized real-provider checks. Any failure blocks completion/release, not silently skipped.

### Task 8: Scoped integration and release

- [ ] Read finishing-a-development-branch skill. Recheck main status and HEAD; rebase onto current main if needed, rerun affected validation, merge only scoped feature commits without touching dirty portrait/theme assets.
- [ ] Follow existing version/release conventions; build actual `frontend/dist` retaining old hashes, verify served bundle and narrowly identified service process before restart. Native shell unchanged: no unnecessary client repackaging.
- [ ] Probe configured proxy, inspect outgoing diff for secrets/private knowledge, dual push according to repository instructions. Verify both refs; do not claim push if either fails. Notify via existing notify.py with concise completion/failure boundaries.

## Coverage self-check

Spec sections4–7: tasks1,2,4. Source/network/price governance: tasks2,3. Scheduling/recovery/performance: tasks1,4,7. Existing aibody/team/human boundaries: tasks4,5. UI: task6. Migration/export: tasks4,5. Verification/deployment: tasks7,8. Method signatures above are the shared contract; adjustments must be reflected here before dependent implementation. No partial layer is described as the completed feature.
