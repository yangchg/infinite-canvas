$ErrorActionPreference = 'Stop'
$relayHealth = 'http://127.0.0.1:17373/health'
try {
    $relayClient = New-Object System.Net.WebClient
    $relayClient.Proxy = $null
    try { $response = $relayClient.DownloadString($relayHealth) | ConvertFrom-Json }
    finally { $relayClient.Dispose() }
    if ($response.service -eq 'canvas-fixed-provider-relay') { return }
    throw 'Port 17373 is occupied by another service.'
} catch {
    if (Get-NetTCPConnection -LocalPort 17373 -State Listen -ErrorAction SilentlyContinue) { throw }
}
$relayNode = (Get-Command node.exe).Source
$relayLogDir = Join-Path $PSScriptRoot 'provider-relay/logs'
New-Item -ItemType Directory -Path $relayLogDir -Force | Out-Null
$relayLogName = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
Start-Process -FilePath $relayNode -ArgumentList ('"' + (Join-Path $PSScriptRoot 'provider-relay/server.mjs') + '"') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $relayLogDir "$relayLogName.jsonl") -RedirectStandardError (Join-Path $relayLogDir "$relayLogName.stderr.log")
