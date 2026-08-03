param(
  [string]$TaskName = "Tysons Times Editorial Pipeline",
  [ValidateSet("auto", "codex", "claude")]
  [string]$Provider = "auto",
  [int]$MaxAiCalls = 12
)

$ErrorActionPreference = "Stop"
$Runner = Join-Path $PSScriptRoot "run-editorial-hourly.ps1"
$Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Runner`" -Provider $Provider -MaxAiCalls $MaxAiCalls"
$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $Arguments
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 45)
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Description "Runs the subscription-backed Tysons Times editorial pipeline every hour." -Force | Out-Null
Write-Host "Installed scheduled task '$TaskName'. It will run hourly while this user is logged in."
