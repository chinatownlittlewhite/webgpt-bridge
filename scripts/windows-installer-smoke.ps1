param(
  [Parameter(Mandatory = $true)][string]$ArtifactsDir,
  [Parameter(Mandatory = $true)][string]$SourcePrep,
  [string]$InstallRoot = (Join-Path $env:ProgramFiles "WebGPT Bridge")
)

$ErrorActionPreference = "Stop"
$taskName = "WebGPT Bridge Host Preparation"
$installer = Get-ChildItem -Path $ArtifactsDir -Filter "WebGPT Bridge-*-win-x64.exe" -File | Select-Object -First 1
if (-not $installer) { throw "built Windows NSIS installer was not found" }
if (-not (Test-Path $SourcePrep -PathType Leaf)) { throw "source host-prep helper was not found: $SourcePrep" }
if (Test-Path $InstallRoot) { throw "pre-existing WebGPT Bridge Program Files installation would invalidate installer smoke" }
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw "pre-existing SYSTEM host-preparation task would invalidate installer smoke" }

$installedPrep = Join-Path $InstallRoot "resources\app.asar.unpacked\agent-runtime\native\windows-host-prep\bin\release\lpc-windows-host-prep.exe"

try {
  & $SourcePrep --remove
  if ($LASTEXITCODE -ne 0) { throw "pre-install host-prep remove failed with exit $LASTEXITCODE" }
  $preInstallJson = & $SourcePrep --check --json
  if ($LASTEXITCODE -ne 0) { throw "pre-install host-prep check failed with exit $LASTEXITCODE" }
  $preInstall = $preInstallJson | ConvertFrom-Json
  if ($preInstall.status -ne "capability_ace_missing") { throw "pre-install host preparation must be capability_ace_missing: $preInstallJson" }

  $install = Start-Process -FilePath $installer.FullName -ArgumentList @("/S") -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "silent NSIS installation failed with exit $($install.ExitCode)" }
  if (-not (Test-Path $installedPrep -PathType Leaf)) { throw "installed host-prep helper was not found under Program Files" }

  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $task) { throw "installed SYSTEM host-preparation task was not registered" }
  if ($task.Principal.UserId -notin @("SYSTEM", "NT AUTHORITY\SYSTEM", "S-1-5-18")) { throw "host-preparation task principal is not SYSTEM: $($task.Principal.UserId)" }
  if ($task.Principal.RunLevel.ToString() -ne "Highest") { throw "host-preparation task is not configured for highest privileges: $($task.Principal.RunLevel)" }
  $taskActions = @($task.Actions)
  if ($taskActions.Count -ne 1) { throw "host-preparation task must have exactly one action" }
  $taskExecute = [IO.Path]::GetFullPath($taskActions[0].Execute.Trim('"'))
  $expectedExecute = [IO.Path]::GetFullPath($installedPrep)
  if (-not [string]::Equals($taskExecute, $expectedExecute, [StringComparison]::OrdinalIgnoreCase)) { throw "host-preparation task executable is not the protected installed helper: $taskExecute" }
  if (([string]$taskActions[0].Arguments).Trim() -ne "--apply") { throw "host-preparation task Arguments must be fixed to --apply: $($taskActions[0].Arguments)" }
  $taskTriggers = @($task.Triggers)
  if ($taskTriggers.Count -ne 1 -or $taskTriggers[0].CimClass.CimClassName -ne "MSFT_TaskBootTrigger") { throw "host-preparation task must have exactly one boot trigger" }

  $installedJson = & $installedPrep --check --json
  if ($LASTEXITCODE -ne 0) { throw "installed host-prep check failed with exit $LASTEXITCODE" }
  $installed = $installedJson | ConvertFrom-Json
  if ($installed.status -ne "ready") { throw "installed host preparation is not ready: $installedJson" }

  $uninstaller = Get-ChildItem -Path $InstallRoot -Filter "Uninstall*.exe" -File | Select-Object -First 1
  if (-not $uninstaller) { throw "installed NSIS uninstaller was not found" }
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList @("/S") -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) { throw "silent NSIS uninstall failed with exit $($uninstall.ExitCode)" }
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw "SYSTEM host-preparation task remained after uninstall" }
  if (Test-Path $installedPrep) { throw "installed host-prep payload remained after uninstall" }

  $removedJson = & $SourcePrep --check --json
  if ($LASTEXITCODE -ne 0) { throw "post-uninstall host-prep check failed with exit $LASTEXITCODE" }
  $removed = $removedJson | ConvertFrom-Json
  if ($removed.status -ne "capability_ace_missing") { throw "uninstall did not remove the product capability ACE: $removedJson" }
}
finally {
  try {
    if (Test-Path $InstallRoot) {
      $cleanupUninstaller = Get-ChildItem -Path $InstallRoot -Filter "Uninstall*.exe" -File -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($cleanupUninstaller) {
        $cleanup = Start-Process -FilePath $cleanupUninstaller.FullName -ArgumentList @("/S") -Wait -PassThru
        if ($cleanup.ExitCode -ne 0) { Write-Warning "installer-smoke cleanup uninstall returned exit $($cleanup.ExitCode)" }
      }
    }
  } catch { Write-Warning "installer-smoke cleanup uninstall failed: $($_.Exception.Message)" }

  try {
    & "$env:SystemRoot\System32\schtasks.exe" /Delete /TN $taskName /F *> $null
  } catch { Write-Warning "installer-smoke task cleanup failed: $($_.Exception.Message)" }

  try {
    & $SourcePrep --remove
    if ($LASTEXITCODE -ne 0) { Write-Warning "installer-smoke host-prep cleanup returned exit $LASTEXITCODE" }
  } catch { Write-Warning "installer-smoke host-prep cleanup failed: $($_.Exception.Message)" }
}
