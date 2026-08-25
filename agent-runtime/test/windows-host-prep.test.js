import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const hostPrepProject = path.join(root, "native", "windows-host-prep", "LocalProjectCoding.WindowsHostPrep.csproj");
const hostPrepSource = path.join(root, "native", "windows-host-prep", "Program.cs");

test("Windows host preparation has a fixed null-device-only command surface", () => {
  assert.ok(fs.existsSync(hostPrepProject), "windows-host-prep project must exist");
  assert.ok(fs.existsSync(hostPrepSource), "windows-host-prep source must exist");
  const source = fs.readFileSync(hostPrepSource, "utf8");
  assert.match(source, /com\.localagenthost\.desktop\.null-device/);
  assert.match(source, /--check/);
  assert.match(source, /--apply/);
  assert.match(source, /--remove/);
  assert.match(source, /DeriveCapabilitySidsFromName/);
  assert.match(source, /GetSecurityInfo/);
  assert.match(source, /SetSecurityInfo/);
  assert.match(source, /SetKernelObjectSecurity/);
  assert.match(source, /FileGenericRead\s*=\s*0x00120089/);
  assert.match(source, /FileGenericWrite\s*=\s*0x00120116/);
  assert.match(source, /NullDeviceAccessMask\s*=\s*unchecked\(\(int\)\(FileGenericRead\s*\|\s*FileGenericWrite\)\)/);
  assert.doesNotMatch(source, /NullDeviceAccessMask\s*=\s*unchecked\(\(int\)\(GenericRead\s*\|\s*GenericWrite\)\)/);
  assert.match(source, /SeKernelObject/);
  assert.match(source, /LabelSecurityInformation/);
  assert.match(source, /WriteOwner/);
  assert.match(source, /S:\(ML;;NW;;;LW\)/);
  assert.doesNotMatch(source, /SaclSecurityInformation/);
  assert.match(source, /TargetName = "NUL"/);
  assert.match(source, /CreateFileW\(\s*"NUL"/);
  assert.doesNotMatch(source, /SetNamedSecurityInfoW/);
  assert.doesNotMatch(source, /Process\.Start|CreateProcess/);
  assert.match(source, /WriteDacl\(preparation\.Handle, updated\)[\s\S]*ReadDacl\(preparation\.Handle\)[\s\S]*HasOwnedAce/);
  assert.match(source, /args\.Length == 2 && args\[0\] == "--check" && args\[1\] == "--json"/);
  assert.match(source, /args\.Length == 1 && args\[0\] == "--apply"/);
  assert.match(source, /args\.Length == 1 && args\[0\] == "--remove"/);
  assert.doesNotMatch(source, /CapabilityName\s*=\s*args|TargetName\s*=\s*args/);
});

test("Windows host preparation requires the low-integrity NUL label as well as the product capability ACE", () => {
  const source = fs.readFileSync(hostPrepSource, "utf8");
  assert.match(source, /HasLowIntegrityLabel/);
  assert.match(source, /present\s*&&\s*lowIntegrity/);
  assert.match(source, /EnsureLowIntegrityLabel/);
  assert.match(source, /LABEL_SECURITY_INFORMATION|LabelSecurityInformation/);
});

test("Windows host preparation mutations explicitly require an administrator token", () => {
  const source = fs.readFileSync(hostPrepSource, "utf8");
  assert.match(source, /operation is "apply" or "remove"/);
  assert.match(source, /!IsAdministrator\(\)/);
  assert.match(source, /elevation_required/);
  assert.match(source, /return 65/);
});

test("Windows host preparation keeps the read-only check usable by a standard user", () => {
  const project = fs.readFileSync(hostPrepProject, "utf8");
  assert.doesNotMatch(project, /<ApplicationManifest>[^<]*app\.manifest<\/ApplicationManifest>/);
  const manifestPath = path.join(root, "native", "windows-host-prep", "app.manifest");
  if (fs.existsSync(manifestPath)) {
    const manifest = fs.readFileSync(manifestPath, "utf8");
    assert.doesNotMatch(manifest, /requestedExecutionLevel[^>]*level="requireAdministrator"/);
  }
});

test("Windows native build publishes sandbox and host preparation as self-contained win-x64 payloads", () => {
  const build = fs.readFileSync(path.join(root, "scripts", "build-native.mjs"), "utf8");
  assert.match(build, /windows-sandbox/);
  assert.match(build, /windows-host-prep/);
  assert.match(build, /-r["']?,\s*["']win-x64/);
  assert.match(build, /--self-contained["']?,\s*["']true/);
  assert.doesNotMatch(build, /PublishSingleFile|PublishTrimmed|PublishAot|NativeAOT/i);
});
