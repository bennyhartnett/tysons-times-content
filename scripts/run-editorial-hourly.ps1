param(
  [ValidateSet("auto", "codex", "claude")]
  [string]$Provider = "auto",
  [int]$MaxAiCalls = 12
)

$ErrorActionPreference = "Stop"
$Repository = Split-Path -Parent $PSScriptRoot
$LogDirectory = Join-Path $Repository ".cache\editorial-pipeline"
$LogPath = Join-Path $LogDirectory "hourly.log"
New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
Set-Location $Repository

"[$(Get-Date -Format o)] starting hourly editorial pipeline" | Add-Content -Path $LogPath
$Output = & node "scripts\editorial-pipeline.mjs" --provider $Provider --max-ai-calls $MaxAiCalls 2>&1
$Code = $LASTEXITCODE
$Output | Out-File -FilePath $LogPath -Append -Encoding utf8
"[$(Get-Date -Format o)] finished with exit code $Code" | Add-Content -Path $LogPath
exit $Code
