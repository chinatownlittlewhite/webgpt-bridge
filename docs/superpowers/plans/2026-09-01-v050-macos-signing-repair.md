# v0.5.0 macOS Signing Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent unsigned macOS releases and rebuild the v0.5.0 macOS installers with Developer ID signing, notarization, stapling, and Gatekeeper validation.

**Architecture:** Keep Electron Builder as the signing/notarization owner. The release workflow must explicitly opt into the formal macOS builder path, supply certificate/notarization secrets, and fail closed before build if any required credential is missing. Post-build checks independently verify codesign, notarization ticket stapling, and Gatekeeper acceptance before artifacts can reach the publish job.

**Tech Stack:** Electron 40, electron-builder 26.15.3, GitHub Actions macOS runners, Apple Developer ID, Apple notarization, `codesign`, `xcrun stapler`, `spctl`.

**Spec:** `docs/release-signing.md`

## Global Constraints

- Formal macOS release must never silently fall back to unsigned output.
- Required GitHub Actions secrets are `MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD`, `MACOS_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.
- `WEBGPT_FORMAL_RELEASE=macos` must be present for the release macOS build.
- `CSC_LINK` and `CSC_KEY_PASSWORD` are passed only to the macOS release job.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` are passed only to the macOS release job.
- Every staged `.app` must pass `codesign --verify --deep --strict --verbose=2`.
- Every DMG must pass `xcrun stapler validate` and `spctl --assess --type open --context context:primary-signature -v`.
- The publish job must remain unable to run until macOS validation passes.
- Repairing v0.5.0 is an explicit exception requested by the repository owner; existing public macOS bytes may be replaced only after the corrected artifacts pass all gates.

---

### Task 1: Add a failing release-contract test

**Files:**
- Modify: `test/release-workflow.test.cjs`

- [ ] **Step 1:** Replace the unsigned-macOS expectation with assertions requiring formal macOS mode, signing secrets, notarization secrets, `codesign`, `stapler`, and `spctl`.
- [ ] **Step 2:** Open a PR so existing CI runs the test against the unchanged workflow.
- [ ] **Step 3:** Confirm the release-workflow test fails because the current workflow has no signing/notarization wiring.

### Task 2: Make the macOS release fail closed and verify trust

**Files:**
- Modify: `.github/workflows/release-desktop.yml`
- Modify: `docs/release-signing.md`

- [ ] **Step 1:** Add macOS-job environment mapping for the six secrets plus `WEBGPT_FORMAL_RELEASE=macos`.
- [ ] **Step 2:** Add an early shell gate that reports missing secret names without printing secret values.
- [ ] **Step 3:** Build with Electron Builder formal macOS mode.
- [ ] **Step 4:** Verify every staged app with `codesign --verify --deep --strict --verbose=2`.
- [ ] **Step 5:** Validate stapling and Gatekeeper acceptance for every DMG before artifact upload.
- [ ] **Step 6:** Update the release policy so signed/notarized macOS is mandatory.
- [ ] **Step 7:** Re-run PR CI and require all tests to pass.

### Task 3: Publish the corrected v0.5.0 artifacts

**Files:**
- No source changes unless CI exposes an implementation defect.

- [ ] **Step 1:** Merge the verified fix to `main`.
- [ ] **Step 2:** Retarget `v0.5.0` to the corrected commit only for this explicitly requested repair.
- [ ] **Step 3:** Re-run the tag release workflow.
- [ ] **Step 4:** Require successful signing, notarization, stapling, Gatekeeper, architecture, native-module, and release-asset validation.
- [ ] **Step 5:** Replace the old v0.5.0 macOS assets only after the corrected artifacts pass all gates, regenerate `latest-mac.yml` and `SHA256SUMS`, and verify the public Release contents.
