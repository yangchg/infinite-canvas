param([string]$ProxyUrl)
$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$composeArgs = @('compose', '--env-file', "$PSScriptRoot\.env", '-f', "$PSScriptRoot\compose.yaml")

function Invoke-Compose {
    & docker @composeArgs @args
    if ($LASTEXITCODE -ne 0) { throw 'Docker command failed. See output above.' }
}

function Assert-NoActiveTasks {
    $check = @'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/app/data/canvas.sqlite', { readOnly: true });
const count = db.prepare("SELECT count(*) AS count FROM canvas_tasks WHERE json_extract(data, '$.state') IN ('queued','running','canceling')").get().count;
db.close();
console.log('Active background tasks:', count);
if (count) { console.error('Wait for tasks to finish or stop them in the app before updating.'); process.exit(1); }
'@
    $check | & docker @composeArgs exec -T backend node --input-type=module
    if ($LASTEXITCODE -ne 0) { throw 'Preflight failed. Backend must be running with no active tasks.' }
}

$oldHttpProxy = $env:HTTP_PROXY
$oldHttpsProxy = $env:HTTPS_PROXY
$oldNoProxy = $env:NO_PROXY
try {
    if (-not (Test-Path -LiteralPath "$PSScriptRoot\.env")) { throw 'Missing deploy/windows/.env. Follow README.md for first deployment.' }
    if ($ProxyUrl) {
        $env:HTTP_PROXY = $ProxyUrl
        $env:HTTPS_PROXY = $ProxyUrl
        $env:NO_PROXY = 'localhost,127.0.0.1'
    }
    Write-Host 'Keep other users from starting tasks until this update finishes.'
    Assert-NoActiveTasks
    Write-Host 'Building images; current containers stay running...'
    Invoke-Compose build app backend
    Assert-NoActiveTasks

    $backupName = 'before-update-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
    $backupPath = Join-Path $repoRoot "data\backups\$backupName"
    $containerId = Invoke-Compose ps -q backend
    if (-not $containerId) { throw 'Running backend container not found.' }
    Invoke-Compose exec -T backend node scripts/backup.js "/tmp/$backupName"
    New-Item -ItemType Directory -Path $backupPath | Out-Null
    & docker cp "${containerId}:/tmp/$backupName/." $backupPath
    if ($LASTEXITCODE -ne 0) { throw 'Backup copy failed; containers have not been replaced.' }
    Write-Host "Backup saved: $backupPath"
    Assert-NoActiveTasks

    & "$PSScriptRoot\Start-Canvas.ps1"
    Invoke-Compose ps
    $verify = @'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/app/data/canvas.sqlite', { readOnly: true });
const result = db.prepare('PRAGMA quick_check').get();
db.close();
if (result.quick_check !== 'ok') throw new Error('Database check failed');
for (const path of ['/', '/notifications/dingtalk/health']) {
    const response = await fetch('http://app:3000' + path);
    console.log(path, response.status);
    if (!response.ok) throw new Error('Service check failed: ' + path);
}
console.log('Database check: ok');
'@
    $verify | & docker @composeArgs exec -T backend node --input-type=module
    if ($LASTEXITCODE -ne 0) { throw 'Containers were updated, but verification failed. Inspect service logs before using the app.' }
    Write-Host 'Update complete. Refresh http://localhost:3000 in your browser.'
} catch {
    Write-Host "Update stopped: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    $env:HTTP_PROXY = $oldHttpProxy
    $env:HTTPS_PROXY = $oldHttpsProxy
    $env:NO_PROXY = $oldNoProxy
}
