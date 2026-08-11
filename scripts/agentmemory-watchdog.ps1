param(
  [int]$ProbeIntervalSeconds = 5,
  [int]$FailureThreshold = 3
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$userProfilePath = [Environment]::GetFolderPath('UserProfile')
$iiiPath = Join-Path $userProfilePath '.local\bin\iii.exe'
$runtimeRoot = Join-Path $userProfilePath '.agentmemory'
$configPath = Join-Path $runtimeRoot 'data\iii-config.yaml'
$logRoot = Join-Path $runtimeRoot 'logs'
$pidPath = Join-Path $runtimeRoot 'iii.pid'
$lockPath = Join-Path $runtimeRoot 'watchdog.lock'
$healthUrl = 'http://127.0.0.1:3111/agentmemory/livez'
$workerCommandFragment = (Join-Path $repoRoot 'dist\index.mjs').Replace('\', '/')

if (-not [System.IO.Path]::IsPathFullyQualified($repoRoot) -or
    -not [System.IO.Path]::IsPathFullyQualified($iiiPath) -or
    -not [System.IO.Path]::IsPathFullyQualified($configPath)) {
  throw 'watchdog paths must be absolute'
}
if (-not (Test-Path -LiteralPath $iiiPath -PathType Leaf)) {
  throw "iii binary not found: $iiiPath"
}
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
  throw "iii config not found: $configPath"
}

New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

# FileShare.None makes duplicate watchdogs fail closed without relying on a
# stale PID file. The handle remains open for the lifetime of this process.
try {
  $watchdogLock = [System.IO.File]::Open(
    $lockPath,
    [System.IO.FileMode]::OpenOrCreate,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::None
  )
} catch [System.IO.IOException] {
  exit 0
}

function Write-WatchdogLog([string]$Message) {
  $line = '{0:o} {1}' -f (Get-Date), $Message
  Add-Content -LiteralPath (Join-Path $logRoot 'watchdog.log') -Value $line -Encoding utf8
}

function Get-ManagedEngines {
  return @(
    Get-CimInstance Win32_Process | Where-Object {
      $_.Name -eq 'iii.exe' -and
      $_.CommandLine -like "*$configPath*"
    }
  )
}

function Get-ManagedWorkers {
  return @(
    Get-CimInstance Win32_Process | Where-Object {
      $_.Name -eq 'node.exe' -and
      ($_.CommandLine -replace '\\', '/') -like "*$workerCommandFragment*"
    }
  )
}

function Test-AgentMemoryLive {
  try {
    $response = Invoke-WebRequest -Uri $healthUrl -TimeoutSec 3 -UseBasicParsing
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Stop-ManagedStack {
  # Resolve exact command lines before stopping anything. Never kill generic
  # node.exe/iii.exe processes owned by other projects.
  $workers = @(Get-ManagedWorkers)
  $engines = @(Get-ManagedEngines)
  foreach ($process in @($workers + $engines)) {
    Stop-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
  }
  foreach ($process in @($workers + $engines)) {
    Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
  }
}

function Start-ManagedStack {
  if (@(Get-ManagedEngines).Count -ne 0 -or @(Get-ManagedWorkers).Count -ne 0) {
    throw 'managed engine or worker still exists before start'
  }

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdoutPath = Join-Path $logRoot "engine-$stamp.stdout.log"
  $stderrPath = Join-Path $logRoot "engine-$stamp.stderr.log"
  $startArgs = @{
    FilePath = $iiiPath
    ArgumentList = @('--config', $configPath)
    WorkingDirectory = $repoRoot
    WindowStyle = 'Hidden'
    RedirectStandardOutput = $stdoutPath
    RedirectStandardError = $stderrPath
    PassThru = $true
  }
  $process = Start-Process @startArgs

  Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ascii
  Write-WatchdogLog "started iii pid=$($process.Id) stdout=$stdoutPath stderr=$stderrPath"
}

try {
  $failures = 0
  while ($true) {
    $engines = @(Get-ManagedEngines)
    $workers = @(Get-ManagedWorkers)
    $live = Test-AgentMemoryLive

    if ($engines.Count -eq 1 -and $workers.Count -eq 1 -and $live) {
      $failures = 0
    } else {
      $failures++
      Write-WatchdogLog "probe failed count=$failures engines=$($engines.Count) workers=$($workers.Count) live=$live"
    }

    if ($engines.Count -eq 0 -or $failures -ge $FailureThreshold) {
      Write-WatchdogLog "restarting managed stack engines=$($engines.Count) workers=$($workers.Count) live=$live"
      Stop-ManagedStack
      Start-ManagedStack
      $failures = 0

      # Give iii-exec time to register the worker before probes count against
      # the new process. A real startup failure is retried on the next cycle.
      Start-Sleep -Seconds 15
    } else {
      Start-Sleep -Seconds $ProbeIntervalSeconds
    }
  }
} finally {
  $watchdogLock.Dispose()
}
