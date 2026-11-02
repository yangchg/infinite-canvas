$ErrorActionPreference = 'Stop'
try {
    $notifyDir = Join-Path $PSScriptRoot 'infinite-canvas\tools\dingtalk-notify'
    $notifyDir = (Resolve-Path -LiteralPath $notifyDir).Path
    $notifyServer = Join-Path $notifyDir 'server.mjs'
    $notifyConfig = Join-Path $notifyDir 'config.local.json'
    # Check the saved JSON before stopping the existing service.
    try {
        Get-Content -Raw -Encoding UTF8 -LiteralPath $notifyConfig | ConvertFrom-Json | Out-Null
    } catch {
        throw 'Cannot read configuration as UTF-8 JSON. Check config.local.json; contents omitted to protect credentials.'
    }
    $notifyProcesses = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/', '\').Contains($notifyServer) }
    foreach ($notifyProcess in $notifyProcesses) {
        $runningProcess = Get-Process -Id $notifyProcess.ProcessId -ErrorAction SilentlyContinue
        if ($runningProcess) {
            $runningProcess | Stop-Process
            $runningProcess.WaitForExit()
        }
    }
    & (Join-Path $notifyDir 'Start-Notify.ps1')
    Write-Host 'DingTalk notification service started with the saved configuration.' -ForegroundColor Green
    Write-Host 'Refresh configuration in the canvas notification node, then select recipients.'
} catch {
    Write-Host ('Restart failed: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
