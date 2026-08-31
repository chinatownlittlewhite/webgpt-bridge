# Desktop release policy

## Current distribution mode

WebGPT Bridge publishes desktop builds through GitHub Releases. A release tag must exactly match `v${package.version}`. The workflow creates or reuses an unpublished Draft, builds and validates Windows and macOS artifacts, writes SHA-256 checksums, uploads only the validated files, and publishes the Release as stable only after every required gate succeeds.

Stable public release bytes are immutable by default. The repository owner may explicitly authorize a same-version repair when a published artifact is defective; that repair must retarget the same version tag to the corrected commit, rebuild all public assets, regenerate updater metadata and checksums, and pass the complete release validation before publication.

### Windows

The GitHub release keeps the native helper build, AppContainer host-preparation apply/remove/repair checks, standard-user Agent acceptance, the real NSIS install/uninstall lifecycle smoke, and release-asset validation. Authenticode is not currently a publication gate, so Windows can still display an Unknown Publisher or SmartScreen warning.

### macOS

Formal macOS releases are fail-closed. The release job must set `WEBGPT_FORMAL_RELEASE=macos` and provide all of the following GitHub Actions secrets:

- `MACOS_CSC_LINK`: Developer ID Application certificate exported as a password-protected PKCS#12/P12 value accepted by electron-builder (`CSC_LINK`).
- `MACOS_CSC_KEY_PASSWORD`: password for that certificate (`CSC_KEY_PASSWORD`).
- `MACOS_SIGNING_IDENTITY`: exact `Developer ID Application: ... (TEAMID)` identity used by the builder (`WEBGPT_MAC_IDENTITY`).
- `APPLE_ID`: Apple Account used for notarization.
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password for that account.
- `APPLE_TEAM_ID`: Apple Developer Team ID.

Missing credentials must stop the macOS job before packaging. Electron Builder must use the Developer ID identity with `forceCodeSigning=true` and Apple notarization enabled. Pull-request CI remains unsigned and never receives these production credentials.

The formal job builds arm64, x64, and Universal DMG/ZIP variants and verifies the Electron app plus bundled `tunnel-client` and `cloudflared` architectures. Before any macOS artifact can be uploaded, every staged `.app` must pass `codesign --verify --deep --strict --verbose=2` and notarization-ticket validation with `xcrun stapler validate`. Every DMG must also pass Gatekeeper assessment with `spctl --assess --type open --context context:primary-signature -v`. Failure of signing, notarization, stapling, architecture checks, native-module checks, or Gatekeeper assessment blocks publication.

A public macOS package that reports “应用已损坏” after its SHA-256 matches the published checksum is therefore treated as a release defect, not as an expected installation path. Do not instruct users to disable Gatekeeper globally.

### Application updates

The installed app checks the fixed GitHub release feed for stable versions. `allowPrerelease` remains disabled. When a newer version is found, the UI opens the exact GitHub Release in the system browser for manual download; this keeps update installation explicit even though macOS release artifacts are signed and notarized.

The production renderer does not receive an arbitrary update-feed URL or installer path. Test-only loopback updater E2E helpers may remain in the repository, but the formal GitHub release workflow does not depend on the packaged updater-install E2E path.

## Release checklist

1. Keep the root package and lockfile versions aligned with the intended tag.
2. Run the desktop and Agent verification suites.
3. For macOS, confirm all six signing/notarization secrets above are configured; never expose their values in logs or pull-request CI.
4. Create a real tag exactly equal to `v${package.version}`. For an explicitly authorized same-version stable repair, retarget that tag only after the corrected commit is verified.
5. Let the tag workflow build both platforms and require macOS Developer ID signing, Apple notarization, stapling, Gatekeeper assessment, architecture/native checks, and release-asset validation.
6. Confirm the public Release is stable rather than prerelease and contains the expected Windows installer, arm64/x64/Universal macOS DMG/ZIP assets, updater metadata, blockmaps, and `SHA256SUMS`.
7. Outside an explicitly authorized repair, never overwrite a stable public release; publish a higher patch version for ordinary stable-release fixes.
