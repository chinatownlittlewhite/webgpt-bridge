# Desktop release policy

## Current distribution mode

WebGPT Bridge currently publishes desktop builds directly through GitHub Releases **without requiring external code-signing or Apple notarization credentials**. This is an intentional distribution choice, not a fallback path.

A release tag must still exactly match `v${package.version}`. The release workflow creates or reuses an unpublished Draft, builds and validates Windows and macOS artifacts, writes SHA-256 checksums, uploads the validated files, and only then publishes the Release as stable (`prerelease=false`, latest).

Do not replace the bytes of an already-public version. If a published version needs a fix, increment the patch version and publish a new tag.

### Windows

The GitHub release keeps the native helper build, AppContainer host-preparation apply/remove/repair checks, standard-user Agent acceptance, the real NSIS install/uninstall lifecycle smoke, and release-asset validation. Authenticode is not a publication gate in the current mode, so Windows can display an Unknown Publisher or SmartScreen warning.

### macOS

The GitHub release builds a Universal DMG and ZIP and verifies `arm64` plus `x86_64` slices for the Electron app, `tunnel-client`, and `cloudflared`. Developer ID signing, notarization, stapling, and Gatekeeper assessment are not publication gates in the current mode, so users can receive the normal macOS warning for an unsigned/not-notarized application.

### Application updates

The installed app checks the fixed GitHub release feed for stable versions. `allowPrerelease` remains disabled. When a newer version is found, the UI opens the exact GitHub Release in the system browser for manual download instead of downloading and installing an unsigned build inside the app.

The production renderer does not receive an arbitrary update-feed URL or installer path. Test-only loopback updater E2E helpers may remain in the repository, but the formal GitHub release workflow does not depend on the signed 90.0.0 → 90.0.1 updater-install E2E path.

## Optional future signing support

The builder still contains opt-in signing configuration so signed distribution can be restored later without redesigning packaging. It is not used by the current GitHub-only release workflow.

For Windows, the previous design used Microsoft Artifact Signing / Trusted Signing with the **Artifact Signing Certificate Profile Signer** role, a protected `desktop-release-windows` environment, `AZURE_FEDERATED_TOKEN_FILE`, and `WEBGPT_WINDOWS_PUBLISHER`. It intentionally did not require an `AZURE_CLIENT_SECRET`.

For macOS, the optional builder path can still require a Developer ID identity and notarization inputs when explicitly enabled. Those credentials must remain outside pull-request CI and must never be added back as mandatory inputs unless the release policy intentionally changes again.

## Release checklist

1. Bump the root package and lockfile to a new version.
2. Run the desktop and Agent verification suites.
3. Create a real tag exactly equal to `v${package.version}`.
4. Let the tag workflow build both platforms and validate the final asset set.
5. Confirm the public Release is stable rather than prerelease and contains the expected Windows installer, Universal macOS DMG/ZIP, updater metadata, blockmaps, and `SHA256SUMS`.
6. Never overwrite a public release in place; publish a higher patch version for fixes.
