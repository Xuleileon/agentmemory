param(
  [int]$ProbeIntervalSeconds = 5,
  [int]$FailureThreshold = 3,
  [string]$HealthUrl = 'http://127.0.0.1:3111/agentmemory/livez'
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
$healthUrl = $HealthUrl
$workerCommandFragment = (Join-Path $repoRoot 'dist\index.mjs').Replace('\', '/')

if (-not [System.IO.Path]::IsPathFullyQualified($repoRoot) -or
    -not [System.IO.Path]::IsPathFullyQualified($iiiPath) -or
    -not [System.IO.Path]::IsPathFullyQualified($configPath)) {
  throw 'watchdog paths must be absolute'
}
if ($ProbeIntervalSeconds -lt 1 -or $FailureThreshold -lt 1) {
  throw 'watchdog intervals and thresholds must be positive integers'
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
  try {
    Add-Content -LiteralPath (Join-Path $logRoot 'watchdog.log') -Value $line -Encoding utf8
  } catch {
    # A transient logging failure must never take down the supervisor.
  }
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
    return [pscustomobject]@{ Kind = 'live'; Detail = "http $($response.StatusCode)" }
  } catch {
    $statusCode = $null
    try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}
    if ($statusCode -eq 404) {
      return [pscustomobject]@{ Kind = 'missing-route'; Detail = 'http 404' }
    }

    $message = $_.Exception.Message
    $kind = if ($message -match 'timed out|timeout|canceled') { 'timeout' } else { 'unreachable' }
    return [pscustomobject]@{ Kind = $kind; Detail = $message }
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
  # iii defaults to verbose INFO output even when the AgentMemory config has
  # console logging disabled. Keep warnings/errors for post-mortems without
  # letting a long-running daemon grow an unbounded operational trace.
  $env:RUST_LOG = 'warn'
  $process = Start-Process @startArgs

  Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ascii
  Write-WatchdogLog "started iii pid=$($process.Id) stdout=$stdoutPath stderr=$stderrPath"
}

try {
  $failures = 0
  while ($true) {
    try {
      $engines = @(Get-ManagedEngines)
      $workers = @(Get-ManagedWorkers)
      $probe = Test-AgentMemoryLive

      $structureMissing = $engines.Count -ne 1 -or $workers.Count -ne 1
      $routeMissing = $probe.Kind -eq 'missing-route'
      if ($structureMissing -or $routeMissing) {
        $failures++
        Write-WatchdogLog "probe failed count=$failures engines=$($engines.Count) workers=$($workers.Count) probe=$($probe.Kind) detail=$($probe.Detail)"
      } else {
        $failures = 0
        if ($probe.Kind -ne 'live') {
          # A saturated but present worker can make /livez exceed 3 seconds.
          # Killing it turns load shedding into an outage, so timeouts and
          # connection stalls are diagnostic-only while both processes exist.
          Write-WatchdogLog "probe degraded engines=1 workers=1 probe=$($probe.Kind) detail=$($probe.Detail)"
        }
      }

      if ($engines.Count -eq 0 -or $failures -ge $FailureThreshold) {
        Write-WatchdogLog "restarting managed stack engines=$($engines.Count) workers=$($workers.Count) probe=$($probe.Kind)"
        try {
          Stop-ManagedStack
          Start-ManagedStack
          Write-WatchdogLog 'restart completed'
        } catch {
          # A process can linger briefly after Stop-Process. Keep the task
          # alive and retry from freshly enumerated PIDs on the next cycle.
          Write-WatchdogLog "restart failed; will retry: $($_.Exception.Message)"
        }
        $failures = 0

        # A large persisted index can take over 20 seconds to register every
        # route. Process presence protects this grace window from false kills.
        Start-Sleep -Seconds 30
      } else {
        Start-Sleep -Seconds $ProbeIntervalSeconds
      }
    } catch {
      Write-WatchdogLog "supervision loop error; continuing: $($_.Exception.Message)"
      Start-Sleep -Seconds $ProbeIntervalSeconds
    }
  }
} finally {
  $watchdogLock.Dispose()
}
