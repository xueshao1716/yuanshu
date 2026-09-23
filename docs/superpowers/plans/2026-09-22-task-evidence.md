# 真实任务验收 Implementation Plan

Goal: Connect reviewable run output to human acceptance and conservative skill evidence, expose actual evolution progress.
Architecture: Snapshot and bounded artifact reader; review store; progress projection; authenticated API and existing evolution page. Existing governance remains in charge of strategy activation.
Tech Stack: Node ESM, React/TypeScript, SWR, node:test and Playwright.

## 1. Snapshot and review service
- [x] Add failing tests in `tests/unit/task-evidence.test.mjs` for successful skill extraction, content binding, accept/reject/revoke and stale revisions.
- [x] Implement `engine/task-evidence-snapshot.mjs` for run-bound events and bounded local artifacts.
- [x] Implement `engine/task-evidence.mjs` for persistent review records and verified episodes. Only server-resolved skills can enter labels.
- [x] Run `node --test tests/unit/task-evidence.test.mjs` and require all cases passing.

## 2. Connect evidence and progress
- [x] Test reviewed episodes through `runEvolutionCycle` without relaxing holdout/governance.
- [x] Add `engine/evolution-progress.mjs`; expose source counts, deduplicated groups and phase-specific requirements.
- [x] Wire service into server dream routes and cycle via explicit dependency injection.

## 3. User interface
- [x] Add typed API, focused review editor and evidence/progress panel; mount in EvolutionView.
- [x] Require review note; leave skill selections unchecked; refresh conflicts rather than resubmit blindly.
- [x] Show missing evidence and historical approval separately from current acceptance.

## 4. Verify and deploy
- [x] Isolated API/browser acceptance: submit, refresh, revoke, stale content, small viewport.
- [x] Run `node scripts/verify-workbench.mjs`; check source fingerprint, full suite, types/build and Impeccable.
- [x] Increment patch version, build serving dist preserving earlier hashed assets, check idle, restart official service.
- [x] Verify actual live state and public bundle; document limitations and counts without approving real user tasks.

## Delivery evidence — 2026-09-22

- Version 2.114.5 deployed to the web service. All 1823 unit tests passed (0 failed/skipped); types and isolated build passed. Source verification digest: `17b1d84d35f301c3721012cd675e8be4ecc39c3e9760adff90e0b81735e85ef7`.
- Actual HTTP/browser fixture acceptance passed at 1440px and 390px: review persistence, revoke, changed-file conflict, type coverage, Team separation, image rendering, authentication/body limits, touch targets and no horizontal overflow. Impeccable returned no findings.
- Serving frontend build passed. Official restart ran after confirming 0 active tasks. Health returned 200; one listening process remained. Live frontend-version returned 2.114.5.
- Disk, localhost and public site serve identical main and Apps chunk bytes: `index-C-adGhCo.js` (SHA256 `28dc3346f46a8868d6fe2899c42e690a23b3d0b74bb8574a1abf398662cec449`) and `Apps-CtEyS81p.js` (SHA256 `19b0c9579b8b9aecf635802c1c98286b81b7f1a7838f140b19fe990ee2eafcfc`). Current Apps chunk contains the new acceptance panel.
- Production read-only checks: evidence list returns latest 40 of 421 runs, 0 retained reviews; completed task detail is reviewable; unauthenticated access returns 401. Progress shows 12 observed, 0 qualified, collecting; Team shows 1 observed, 0 accepted. No production acceptance was submitted and no real-model improvement is claimed.
- Windows/Android installers were not rebuilt. Existing build deprecation and bundle-size warnings remain; they do not fail the build. Limits are documented in `docs/EVOLUTION-EVIDENCE.md`.
