# Desktop release signing

Formal desktop releases are tag-triggered, draft-first GitHub Releases. Platform signing credentials exist only in protected GitHub Environments and are never exposed to pull-request CI.

## Windows — Microsoft Artifact Signing / Trusted Signing

The protected GitHub Environment is `desktop-release-windows`.

Configure these Environment variables:

- `AZURE_TENANT_ID` — Microsoft Entra tenant that owns the signing application.
- `AZURE_CLIENT_ID` — client ID of the Entra application/service principal used only for signing.
- `WEBGPT_WINDOWS_SIGN_ENDPOINT` — regional Artifact Signing / Trusted Signing endpoint.
- `WEBGPT_WINDOWS_SIGN_ACCOUNT` — signing account name.
- `WEBGPT_WINDOWS_SIGN_PROFILE` — Public Trust certificate profile name.
- `WEBGPT_WINDOWS_PUBLISHER` — exact certificate subject expected on every signed executable and by electron-updater.

Create a Microsoft Artifact Signing Public Trust account/profile and grant the service principal the **Artifact Signing Certificate Profile Signer** role at the narrowest available signing account/profile scope. Create a GitHub federated credential whose subject is tied to the `desktop-release-windows` Environment. The workflow requests a GitHub OIDC token with audience `api://AzureADTokenExchange`, writes it only to a temporary runner file, and exposes that path as `AZURE_FEDERATED_TOKEN_FILE`. The temporary token file is removed in an `always()` cleanup step.

The Windows formal build is fail-closed. `WEBGPT_FORMAL_RELEASE=windows` makes Electron Builder require `WEBGPT_WINDOWS_PUBLISHER`, `WEBGPT_WINDOWS_SIGN_ENDPOINT`, `WEBGPT_WINDOWS_SIGN_ACCOUNT`, and `WEBGPT_WINDOWS_SIGN_PROFILE`; missing identity configuration aborts packaging. After the real NSIS lifecycle smoke, CI verifies the installer, packaged app executable, Windows sandbox helper, and Windows host-preparation helper with `Get-AuthenticodeSignature`. Every required file must report `Valid`, have signer subject exactly equal to `WEBGPT_WINDOWS_PUBLISHER`, and include a timestamp certificate.

No long-lived Azure credential is required by this design. The browser-visible goal is a valid Microsoft Authenticode signature and the expected **Verified Publisher** identity. Code signing does not promise that a newly issued publisher will immediately have zero Microsoft Defender SmartScreen reputation prompts.

## macOS — Developer ID, notarization, and true Universal payloads

The protected GitHub Environment is `desktop-release-macos`.

Configure these Environment secrets:

- `MAC_CSC_LINK` — the exported Developer ID Application certificate/private key in an Electron Builder-supported `CSC_LINK` form, typically a base64-encoded `.p12`.
- `MAC_CSC_KEY_PASSWORD` — password protecting that certificate export.
- `APPLE_API_KEY_BASE64` — base64 encoding of the App Store Connect Team API key `.p8` file.

Configure these Environment variables:

- `WEBGPT_MAC_IDENTITY` — exact Developer ID Application identity, for example `Developer ID Application: Example Company (TEAMID1234)`.
- `APPLE_API_KEY_ID` — App Store Connect API Key ID.
- `APPLE_API_ISSUER` — App Store Connect API Issuer ID.

Use a **Developer ID Application** certificate for direct distribution, not a Mac App Store distribution certificate. Export the certificate/private key to the protected `MAC_CSC_LINK` secret and keep the exact expected identity in `WEBGPT_MAC_IDENTITY`; the formal Builder config sets `forceCodeSigning` and fails if that identity is absent.

For notarization, create an App Store Connect Team API key with only the access required for the release process. CI decodes `APPLE_API_KEY_BASE64` into `$RUNNER_TEMP/AuthKey_<id>.p8`, sets mode `0600`, and exports its path as `APPLE_API_KEY`. `electron-builder@26.15.3` passes that file path together with `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` to `@electron/notarize`. The `.p8` is removed by an `always()` cleanup step. The workflow itself does not create a persistent keychain; Electron Builder owns temporary certificate import/cleanup for `CSC_LINK`.

The macOS build is required to be Universal at every executable layer used by the product. CI checks `arm64` and `x86_64` slices for the Electron application executable, the bundled `tunnel-client`, and its adjacent `cloudflared` companion. The tunnel-client preparation step downloads the official macOS arm64 and amd64 v0.0.11 release archives only after both archive SHA-256 values have been pinned in `scripts/tunnel-client-release.json`, verifies each archive byte-for-byte against those pins, and combines both executable pairs with `/usr/bin/lipo`. Electron Builder's `mac.binaries` list then signs the two embedded native executables with the same formal Developer ID release.

After packaging, CI requires `codesign --verify --deep --strict` for the app, strict signature verification for both embedded native binaries, the expected Developer ID authority, a valid stapled notarization ticket on the `.app`, and a successful Gatekeeper `spctl --assess`. The release must also contain exactly one Universal DMG and ZIP. The DMG container is not separately forced through signing/stapling: the notarized and stapled application bundle inside it is the Gatekeeper trust boundary, and forcing DMG signing can interfere with Electron Builder's normal notarization/update artifact lifecycle.

Do not use `xattr -cr` or quarantine removal as a release acceptance strategy. A formal release must pass signing, notarization, stapling, and Gatekeeper checks without weakening the user's normal macOS security path.

## Packaged updater E2E and publication checklist

Every formal platform job builds two additional signed test-only packages, `90.0.0` and `90.0.1`, whose updater feed is fixed at build time to `http://127.0.0.1:18181/`. Production artifacts continue to use the fixed GitHub provider and explicitly exclude `src/update-e2e-control.cjs`; there is no production environment variable, renderer IPC, or settings field that can override the update feed.

The loopback E2E server serves only top-level files from the generated `90.0.1` artifact directory, rejects nested/traversal paths, and supports HTTP byte ranges. The old packaged app must discover `90.0.1`, download it through the same updater service used by the UI, install and relaunch, and the relaunched app must report `{ version: "90.0.1", phase: "updated" }` through the test-only sentinel. Windows then rechecks host-prep readiness and the fixed SYSTEM task; macOS rechecks the updated app signature/staple and Universal main executable.

Before creating a tag:

1. Set the root `package.json` version to the intended stable version.
2. Create a tag **exactly** equal to `v${package.version}`. The release workflow rejects any mismatch.
3. Confirm protected Environments `desktop-release-windows` and `desktop-release-macos` contain the required variables/secrets described above.
4. Do not publish or reuse an already-public Release for that tag. The workflow creates/reuses only an unpublished Draft.
5. Both signed platform jobs, packaged updater E2E gates, `latest.yml` / `latest-mac.yml` SHA-512 validation, and user-facing SHA-256 generation must succeed before the Draft can become stable.

If any platform or validation step fails, leave the Release as Draft and fix the code/workflow. Once a version has been publicly released, do not replace its bytes in place; publish a higher patch version instead.
