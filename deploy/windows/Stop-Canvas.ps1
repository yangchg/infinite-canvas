$ErrorActionPreference = 'Stop'
docker compose --env-file "$PSScriptRoot\.env" -f "$PSScriptRoot\compose.yaml" stop
if ($LASTEXITCODE -ne 0) { throw 'Failed to stop Infinite Canvas.' }
