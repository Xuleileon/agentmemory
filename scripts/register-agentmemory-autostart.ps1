param(
  [string]$TaskName = 'AgentMemoryWatchdog'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$watchdogPath = Join-Path $repoRoot 'scripts\agentmemory-watchdog.ps1'
$pwshPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
$account = '{0}\{1}' -f $env:USERDOMAIN, $env:USERNAME

if (-not (Test-Path -LiteralPath $watchdogPath -PathType Leaf)) {
  throw "watchdog script not found: $watchdogPath"
}
if (-not [System.IO.Path]::IsPathFullyQualified($repoRoot)) {
  throw "repo root must be absolute: $repoRoot"
}

$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $watchdogPath
$action = New-ScheduledTaskAction `
  -Execute $pwshPath `
  -Argument $arguments `
  -WorkingDirectory $repoRoot

$triggers = @(
  New-ScheduledTaskTrigger -AtStartup
  New-ScheduledTaskTrigger -AtLogOn -User $account
)

# S4U lets the task start headlessly at boot without storing the user's
# password. AgentMemory only needs local E: and the local user profile.
$principal = New-ScheduledTaskPrincipal `
  -UserId $account `
  -LogonType S4U `
  -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
  -Hidden `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

$definition = New-ScheduledTask `
  -Action $action `
  -Trigger $triggers `
  -Principal $principal `
  -Settings $settings `
  -Description 'Hidden boot-time supervisor for the E:\agentmemory local fork.'

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and $existing.State -eq 'Running') {
  Stop-ScheduledTask -TaskName $TaskName
}

$mode = 'boot-s4u'
try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -InputObject $definition `
    -Force `
    -ErrorAction Stop | Out-Null
} catch {
  if ($_.Exception.Message -notmatch 'denied|拒绝访问') {
    throw
  }

  # Creating a machine boot trigger with S4U requires elevation on Windows.
  # The non-admin fallback is still hidden and automatic, but starts when the
  # user's desktop session logs on instead of before logon.
  $mode = 'logon-hidden'
  $fallbackPrincipal = New-ScheduledTaskPrincipal `
    -UserId $account `
    -LogonType Interactive `
    -RunLevel Limited
  $fallbackDefinition = New-ScheduledTask `
    -Action $action `
    -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $account) `
    -Principal $fallbackPrincipal `
    -Settings $settings `
    -Description 'Hidden logon-time supervisor for the E:\agentmemory local fork.'
  Register-ScheduledTask `
    -TaskName $TaskName `
    -InputObject $fallbackDefinition `
    -Force `
    -ErrorAction Stop | Out-Null
}

Start-ScheduledTask -TaskName $TaskName

$registered = Get-ScheduledTask -TaskName $TaskName
if (-not $registered.Settings.Hidden) {
  throw 'registered task is not hidden'
}
if ($mode -eq 'boot-s4u' -and -not ($registered.Triggers | Where-Object CimClass -match 'BootTrigger')) {
  throw 'registered S4U task is missing the startup trigger'
}
if ($mode -eq 'logon-hidden' -and -not ($registered.Triggers | Where-Object CimClass -match 'LogonTrigger')) {
  throw 'registered fallback task is missing the logon trigger'
}

Write-Output "Registered hidden AgentMemory autostart task '$TaskName' mode=$mode for $account using $watchdogPath"
