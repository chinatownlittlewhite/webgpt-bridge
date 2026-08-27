param(
  [Parameter(Mandatory = $true)][string]$ArtifactsDir,
  [Parameter(Mandatory = $true)][string]$SourcePrep,
  [string]$InstallRoot = (Join-Path $env:SystemDrive "WebGPT-Bridge-Custom-Install-Smoke")
)

$ErrorActionPreference = "Stop"
$taskName = "WebGPT Bridge Host Preparation"
$installer = Get-ChildItem -Path $ArtifactsDir -Filter "WebGPT-Bridge-*-win-x64.exe" -File | Select-Object -First 1
if (-not $installer) { throw "built Windows NSIS installer was not found" }
if (-not (Test-Path $SourcePrep -PathType Leaf)) { throw "source host-prep helper was not found: $SourcePrep" }
if (Test-Path $InstallRoot) { throw "pre-existing WebGPT Bridge custom installation would invalidate installer smoke" }
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw "pre-existing SYSTEM host-preparation task would invalidate installer smoke" }

function Get-PathSizeBytes([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { throw "required size target was not found: $Path" }
  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSIsContainer) { return [int64]$item.Length }
  $sum = (Get-ChildItem -LiteralPath $Path -File -Recurse -Force | Measure-Object -Property Length -Sum).Sum
  if ($null -eq $sum) { return [int64]0 }
  return [int64]$sum
}

$protectedHostRoot = Join-Path $env:ProgramFiles "WebGPT Bridge Host"
$installedPrep = Join-Path $protectedHostRoot "lpc-windows-host.exe"
$installedTaskXml = Join-Path $InstallRoot "resources\windows-host-prep-task.xml"
$resourcesRoot = Join-Path $InstallRoot "resources"
$unpackedRoot = Join-Path $resourcesRoot "app.asar.unpacked"
$agentRuntimeRoot = Join-Path $unpackedRoot "agent-runtime"
$agentNativeRoot = Join-Path $agentRuntimeRoot "native\windows-host\bin\release"

try {
  & $SourcePrep host-prep --remove
  if ($LASTEXITCODE -ne 0) { throw "pre-install host-prep remove failed with exit $LASTEXITCODE" }
  $preInstallJson = & $SourcePrep host-prep --check --json
  if ($LASTEXITCODE -ne 0) { throw "pre-install host-prep check failed with exit $LASTEXITCODE" }
  $preInstall = $preInstallJson | ConvertFrom-Json
  if ($preInstall.status -ne "capability_ace_missing") { throw "pre-install host preparation must be capability_ace_missing: $preInstallJson" }

  $install = Start-Process -FilePath $installer.FullName -ArgumentList @("/S", "/D=$InstallRoot") -Wait -PassThru
  if ($install.ExitCode -ne 0) {
    $taskDiagnosticExit = -1
    $taskDiagnostic = "installed task XML was not found"
    if (Test-Path $installedTaskXml -PathType Leaf) {
      $savedErrorActionPreference = $ErrorActionPreference
      try {
        $ErrorActionPreference = "Continue"
        $taskDiagnosticOutput = & "$env:SystemRoot\System32\schtasks.exe" /Create /TN $taskName /XML $installedTaskXml /F 2>&1 | Out-String
        $taskDiagnosticExit = $LASTEXITCODE
      }
      finally {
        $ErrorActionPreference = $savedErrorActionPreference
      }
      $taskDiagnostic = ([string]$taskDiagnosticOutput).Trim()
      if ($taskDiagnostic.Length -gt 4096) { $taskDiagnostic = $taskDiagnostic.Substring(0, 4096) }
    }
    throw "silent NSIS installation failed with exit $($install.ExitCode); task registration diagnostic exit $taskDiagnosticExit`: $taskDiagnostic"
  }
  if (-not (Test-Path $installedPrep -PathType Leaf)) { throw "protected combined Windows host was not found under Program Files" }
  if (-not (Test-Path (Join-Path $InstallRoot "WebGPT Bridge.exe") -PathType Leaf)) { throw "application was not installed at the requested custom directory: $InstallRoot" }

  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $task) { throw "installed SYSTEM host-preparation task was not registered" }
  if ($task.Principal.UserId -notin @("SYSTEM", "NT AUTHORITY\SYSTEM", "S-1-5-18")) { throw "host-preparation task principal is not SYSTEM: $($task.Principal.UserId)" }
  if ($task.Principal.RunLevel.ToString() -ne "Highest") { throw "host-preparation task is not configured for highest privileges: $($task.Principal.RunLevel)" }
  $taskActions = @($task.Actions)
  if ($taskActions.Count -ne 1) { throw "host-preparation task must have exactly one action" }
  $taskExecuteRaw = ([string]$taskActions[0].Execute).Trim('"')
  $taskExecute = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($taskExecuteRaw))
  $expectedExecute = [IO.Path]::GetFullPath($installedPrep)
  if (-not [string]::Equals($taskExecute, $expectedExecute, [StringComparison]::OrdinalIgnoreCase)) { throw "host-preparation task executable is not the protected installed helper: $taskExecute" }
  if (([string]$taskActions[0].Arguments).Trim() -ne "host-prep --apply") { throw "host-preparation task Arguments must be fixed to host-prep --apply: $($taskActions[0].Arguments)" }
  $taskTriggers = @($task.Triggers)
  if ($taskTriggers.Count -ne 1 -or $taskTriggers[0].CimClass.CimClassName -ne "MSFT_TaskBootTrigger") { throw "host-preparation task must have exactly one boot trigger" }

  $installedJson = & $installedPrep host-prep --check --json
  if ($LASTEXITCODE -ne 0) { throw "installed host-prep check failed with exit $LASTEXITCODE" }
  $installed = $installedJson | ConvertFrom-Json
  if ($installed.status -ne "ready") { throw "installed host preparation is not ready: $installedJson" }

  $sizeReport = [ordered]@{
    installerBytes = Get-PathSizeBytes $installer.FullName
    installRootBytes = Get-PathSizeBytes $InstallRoot
    resourcesBytes = Get-PathSizeBytes $resourcesRoot
    appAsarUnpackedBytes = Get-PathSizeBytes $unpackedRoot
    agentRuntimeBytes = Get-PathSizeBytes $agentRuntimeRoot
    packagedNativeHostBytes = Get-PathSizeBytes $agentNativeRoot
    protectedNativeHostBytes = Get-PathSizeBytes $installedPrep
  }
  $sizeReportJson = $sizeReport | ConvertTo-Json -Compress
  Write-Host ("WINDOWS_INSTALL_SIZE_JSON=" + $sizeReportJson)
  Set-Content -LiteralPath (Join-Path $ArtifactsDir "windows-install-size.json") -Value $sizeReportJson -Encoding UTF8

  & $SourcePrep host-prep --remove
  if ($LASTEXITCODE -ne 0) { throw "scheduled-task execution precondition remove failed with exit $LASTEXITCODE" }
  $taskExecutionPreconditionJson = & $SourcePrep host-prep --check --json
  if ($LASTEXITCODE -ne 0) { throw "scheduled-task execution precondition check failed with exit $LASTEXITCODE" }
  $taskExecutionPrecondition = $taskExecutionPreconditionJson | ConvertFrom-Json
  if ($taskExecutionPrecondition.status -ne "capability_ace_missing") { throw "scheduled-task execution precondition must be capability_ace_missing: $taskExecutionPreconditionJson" }

  Start-ScheduledTask -TaskName $taskName
  $taskRestoredReady = $false
  $taskExecutionJson = ""
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    $taskExecutionJson = & $installedPrep host-prep --check --json
    if ($LASTEXITCODE -eq 0) {
      $taskExecution = $taskExecutionJson | ConvertFrom-Json
      if ($taskExecution.status -eq "ready") {
        $taskRestoredReady = $true
        break
      }
    }
  }
  if (-not $taskRestoredReady) { throw "scheduled task did not restore host preparation to ready: $taskExecutionJson" }

  $repair = Start-Process -FilePath $installer.FullName -ArgumentList @("/S", "/D=$InstallRoot") -Wait -PassThru
  if ($repair.ExitCode -ne 0) { throw "silent NSIS repair installation failed with exit $($repair.ExitCode)" }
  if (-not (Test-Path $installedPrep -PathType Leaf)) { throw "installed host-prep helper was not restored by repair" }
  $repairTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $repairTask) { throw "SYSTEM host-preparation task was not restored by repair" }
  $repairedJson = & $installedPrep host-prep --check --json
  if ($LASTEXITCODE -ne 0) { throw "post-repair host-prep check failed with exit $LASTEXITCODE" }
  $repaired = $repairedJson | ConvertFrom-Json
  if ($repaired.status -ne "ready") { throw "post-repair host preparation is not ready: $repairedJson" }

  $uninstaller = Get-ChildItem -Path $InstallRoot -Filter "Uninstall*.exe" -File | Select-Object -First 1
  if (-not $uninstaller) { throw "installed NSIS uninstaller was not found" }
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList @("/S") -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) { throw "silent NSIS uninstall failed with exit $($uninstall.ExitCode)" }
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw "SYSTEM host-preparation task remained after uninstall" }
  if (Test-Path $installedPrep) { throw "installed host-prep payload remained after uninstall" }

  $removedJson = & $SourcePrep host-prep --check --json
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
    & $SourcePrep host-prep --remove
    if ($LASTEXITCODE -ne 0) { Write-Warning "installer-smoke host-prep cleanup returned exit $LASTEXITCODE" }
  } catch { Write-Warning "installer-smoke host-prep cleanup failed: $($_.Exception.Message)" }
}
