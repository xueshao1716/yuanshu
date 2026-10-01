# Cultivation Evidence Observation Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task in the isolated worktree. Steps use checkbox syntax for tracking.

**Goal:** Show the recorded origin and evidence stages of cultivation candidates without claiming current verification or changing learning authority.

**Architecture:** Extend the existing paginated experience projection using the same batch of knowledge jobs. Render it within Learning, preserve the existing decision/signature component, and distinguish errors and cached data from empty results. No new storage, scheduler, source fetching or model calls.

**Tech Stack:** Node ESM, node:test, React/TypeScript, SWR, existing Playwright fixture server.

**Isolation:** `D:/pi-web/.worktrees/cultivation-evidence-observation`, branch `feat/cultivation-evidence-observation`. Shared dependencies are read-only junctions; tests use verificationEnvironment and verification-preload. Never run a production build or bare npm test.

## Task 1: Bounded, read-only evidence projection

Files: modify `engine/cultivation/experience.mjs`; create `engine/cultivation/experience-observation.mjs`, `tests/unit/cultivation-observation.test.mjs`.

- [x] Write tests through the existing `createCultivationExperience().list()` entrypoint before implementation. Use synthetic run/job records and a repo double that implements only page; the knowledge double only implements getMany, so unexpected scans, writes and source verification fail.

```js
const result = await bridge.list({limit: 20});
assert.deepEqual(result.coverage, {
  basis: 'returned_page', returnedCount: result.items.length,
  hasMore: result.nextCursor !== null, observedAt: fixedNow,
});
assert.equal(result.items[0].observation.sourceCurrent, 'not_checked');
assert.equal(result.items[0].observation.userAcceptance, null);
assert.equal(result.items[0].evidenceCount, 0);
```

- [x] Run the new test file with the isolated test command below; require assertion failures for missing observation/coverage.
- [x] Add pure `experienceObservation(run, job)` projection. Pass only the already-associated job; invalid runId/outputHash must pass null. Return lineage, linked/invalidated, model_generated, resolutionRecorded, sourceCurrent:not_checked, latest decisions per scope, userAcceptance:null. Copy only scope/decision/actor.kind/at/version/entryId; never include actor credentials or reason text in the new projection. Use append order, matching existing learning-decision semantics, not clock time.
- [x] Add injectable `now = Date.now` to the factory; list adds page-only coverage with one timestamp, no new reads. Keep all existing fields unchanged and suppress resolution/decisions when the existing link check fails.
- [x] Test empty pages, 50-item bound, multiple scopes/adopt-retire, absent optional historical fields, invalid hash/runId/missing jobs, detached records, paging/recreation identity, propagated read failure, and exactly one batch read.
- [x] Run focused cultivation tests and inspect the diff before committing the projection slice.

## Task 2: Existing learning page and stale-state safety

Files: modify `frontend/src/soul/cultivation/{api.ts,Learning.tsx,Panel.tsx,cultivation.css}`; create `frontend/src/soul/cultivation/Evidence.tsx`; extend `tests/unit/cultivation-panel.test.mjs`.

- [x] Add failing source-contract checks for optional observation/coverage compatibility, page-only counts, explicit old-data timestamp, and guarded adoption on stale data. Existing adoption tests remain unchanged.
- [x] Add `ExperienceObservation`, `ExperienceCoverage` types; use optional fields so an older server produces an explicit unavailable observation message, never fabricated zero counts.
- [x] Add Evidence summary and per-item details using definition lists and ordinary text. Show individual/design/run/job IDs, optional resolution IDs, and latest recorded decisions by scope. Missing design identifiers display unrecorded. No raw HTML, new endpoint, or hidden request.

```tsx
<Learning items={experience.data.items} coverage={experience.data.coverage}
  stale={!!experience.error} authorized={!!overview.data?.humanGrantAvailable}
  onAction={setAction}/>
```

- [x] Summary counts only items returned on the current page; label count overlap and more-page availability. Coverage time is projection time, not source verification time. If stale, show cached time and disable decision preparation; LoadState keeps the actionable read error visible.
- [x] Render “本页暂无记录” only for a successful empty response. Do not render zero counts/normal empty state on failure. Keep polling configuration and independent pagination unchanged.
- [x] Use existing theme variables and responsive grid for summary/lineage, with long IDs wrapping. Do not restyle unrelated tabs or alter resources' unknown-soil notice.
- [x] Run focused contract tests and frontend typecheck; inspect output before commit.

## Task 3: Isolated acceptance and delivery

Files: create `tests/e2e/cultivation-evidence.playwright.mjs`, using existing local-only fixture server pattern; record results in `docs/verification/2026-10-01-cultivation-evidence-observation.md`.

- [x] Run `npm run verify` in the worktree. Inspect all unit, type and build results. Build must output only `tmp/verification-dist`. Final exit 0: 3126 passed, 0 failed, 1 OS-denied symlink skip; types/build passed, fingerprint state passed.
- [x] Browser test at 1440px and 390px: empty response, populated lineage, latest decisions, invalid association, older-server response, fresh failure, cached failure timestamp, read recovery, pagination conflict and reset. Assert no horizontal overflow, no page errors, no mutation requests; capture screenshots with synthetic data only.
- [x] Run existing cultivation browser test to preserve authorization/media isolation and hidden-page polling coverage.
- [x] Run Impeccable detect on changed front-end components; classify any finding precisely rather than claiming an unrun check. Final exit 1 reports only the unchanged line-19 font-size advisory; no new finding.
- [x] Inspect full diff and actual browser layout; verify no business memory, gene/approval source, production assets or private data changed. Prepare only this task's files for commit. Preserve isolated branch for review; no push/restart or release-version bump in this implementation-only slice.
- [ ] Visual screenshot reading remains unavailable: the image tool rejected reading images. Screenshots exist; DOM interactions, measured layout and current-theme contrast were checked instead. This is a documented acceptance limitation, not a claimed visual pass.

Final evidence and delivery boundaries: `docs/verification/2026-10-01-cultivation-evidence-observation.md`.

### Isolated focused-test command

```powershell
node --input-type=module -e "import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {verificationEnvironment} from './scripts/verification-runner.mjs'; const temp=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-evidence-test-'));const files=fs.readdirSync('tests/unit').filter(n=>/^cultivation-.*[.]test[.]mjs$/.test(n)).map(n=>'tests/unit/'+n);const r=spawnSync(process.execPath,['--import',new URL('./scripts/verification-preload.mjs',import.meta.url).href,'--test','--test-concurrency=1',...files],{env:verificationEnvironment(temp),stdio:'inherit',windowsHide:true});process.exitCode=r.status??1;"
```

Expected after implementation: no failing cultivation tests. Full acceptance additionally requires `npm run verify` and both browser scripts. Test files use synthetic data and never point at the actual business workspace.
