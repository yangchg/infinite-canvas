param([switch]$Build)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.env'))) {
    throw 'Copy .env.example to .env and set CANVAS_LAN_IP first.'
}
& (Join-Path $PSScriptRoot 'Start-ProviderRelay.ps1')
& (Join-Path $PSScriptRoot '..\..\tools\dingtalk-notify\Start-Notify.ps1')
if ($Build) {
    docker compose --env-file "$PSScriptRoot\.env" -f "$PSScriptRoot\compose.yaml" build app
    if ($LASTEXITCODE -ne 0) { throw 'Build failed; existing container was not replaced.' }
}
docker compose --env-file "$PSScriptRoot\.env" -f "$PSScriptRoot\compose.yaml" up -d --no-build
if ($LASTEXITCODE -ne 0) { throw 'Docker deployment failed.' }
Write-Host 'Infinite Canvas: http://localhost:3000'
