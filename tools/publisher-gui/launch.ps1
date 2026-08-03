$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$url = "http://127.0.0.1:4784"
$health = "$url/api/health"
$cache = Join-Path $repo ".cache"
$stdoutLog = Join-Path $cache "publisher-console.log"
$stderrLog = Join-Path $cache "publisher-console-error.log"

$alreadyRunning = $false
try {
  $response = Invoke-RestMethod -Uri $health -TimeoutSec 2
  $alreadyRunning = [bool]$response.ok
} catch {
  $alreadyRunning = $false
}

if (-not $alreadyRunning) {
  New-Item -ItemType Directory -Path $cache -Force | Out-Null
  $node = (Get-Command node -ErrorAction Stop).Source
  $server = Join-Path $PSScriptRoot "server.mjs"
  Start-Process -FilePath $node `
    -ArgumentList @($server, "--no-open") `
    -WorkingDirectory $repo `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog

  $ready = $false
  foreach ($attempt in 1..40) {
    Start-Sleep -Milliseconds 250
    try {
      $response = Invoke-RestMethod -Uri $health -TimeoutSec 1
      if ($response.ok) {
        $ready = $true
        break
      }
    } catch {
      # The local server is still starting.
    }
  }
  if (-not $ready) {
    $detail = if (Test-Path $stderrLog) { Get-Content $stderrLog -Raw } else { "No server log was created." }
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show("Publisher Desk could not start.`n`n$detail", "Tysons Times Publisher Desk", "OK", "Error") | Out-Null
    exit 1
  }
}

Start-Process $url
