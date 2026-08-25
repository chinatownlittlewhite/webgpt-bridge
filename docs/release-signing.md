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

## macOS

The macOS Developer ID and notarization setup is documented in the macOS release-signing task below this section once that workflow is enabled.
