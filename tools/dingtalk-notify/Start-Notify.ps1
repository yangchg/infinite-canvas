$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'config.local.json'))) { throw 'Create config.local.json from config.example.json and fill in app credentials and employee userIds first.' }
try {
    $notifyHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:17374/health'
    if ($notifyHealth.service -eq 'canvas-dingtalk-notify') { return }
} catch {
    if (Get-NetTCPConnection -LocalPort 17374 -State Listen -ErrorAction SilentlyContinue) { throw }
}
Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList ('"' + (Join-Path $PSScriptRoot 'server.mjs') + '"') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'stdout.log') -RedirectStandardError (Join-Path $PSScriptRoot 'stderr.log')
