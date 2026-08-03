$ErrorActionPreference = "Stop"

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "Tysons Times Publisher Desk.lnk"
$launcher = (Resolve-Path (Join-Path $PSScriptRoot "launch.ps1")).Path
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powershell
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
$shortcut.WorkingDirectory = $repo
$shortcut.Description = "Open the Tysons Times scraper, staging, preview, and publishing console"
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,220"
$shortcut.Save()

Write-Output $shortcutPath
