param(
    [string]$Release,
    [string]$Config,
    [string]$InstallRoot = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
if (-not $Release) {
    $manifest = Join-Path $PSScriptRoot 'deployment-manifest.json'
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifest).Hash.Substring(0,16).ToLowerInvariant()
    $Release = Join-Path $InstallRoot "releases\$hash"
}
if (-not $Config) { $Config = Join-Path $InstallRoot 'private\client.env' }
if (-not (Test-Path (Join-Path $Release '.install-complete'))) { throw '客户端尚未安装，请先运行 install-client-native.cmd。' }
if (-not (Get-Command pg_isready.exe -ErrorAction SilentlyContinue)) { throw '未找到 pg_isready.exe。' }
& pg_isready.exe -h 127.0.0.1 -p 5432 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL 127.0.0.1:5432 未就绪。' }
$backend = Join-Path $Release 'backend'
$env:DOTENV_CONFIG_PATH = $Config
$env:NODE_ENV = 'production'
$backendLog = Join-Path $InstallRoot 'logs\backend.log'
$webLog = Join-Path $InstallRoot 'logs\web.log'
New-Item -ItemType Directory -Force -Path (Split-Path $backendLog) | Out-Null
$backendErrorLog = Join-Path $InstallRoot 'logs\backend-error.log'
$webErrorLog = Join-Path $InstallRoot 'logs\web-error.log'
$backendProcess = Start-Process -FilePath node.exe -ArgumentList 'dist/server.js' -WorkingDirectory $backend -RedirectStandardOutput $backendLog -RedirectStandardError $backendErrorLog -PassThru
$webProcess = Start-Process -FilePath node.exe -ArgumentList 'dist/cli/local-http-server.js' -WorkingDirectory $backend -RedirectStandardOutput $webLog -RedirectStandardError $webErrorLog -PassThru
try {
    for ($i = 0; $i -lt 120; $i++) {
        Start-Sleep -Seconds 1
        if ($backendProcess.HasExited -or $webProcess.HasExited) { throw '客户端进程在启动期间退出，请查看 %LOCALAPPDATA%\MiaoshouAuto\logs。' }
        try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8080/' -TimeoutSec 2 | Out-Null; Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8080/auth/session' -TimeoutSec 2 | Out-Null; break } catch { if ($i -eq 119) { throw '客户端启动超时，请查看日志。' } }
    }
    Write-Host '客户端已启动：http://127.0.0.1:8080/'
    Start-Process 'http://127.0.0.1:8080/'
    Write-Host '保持此窗口打开；关闭窗口将停止客户端。'
    while (-not $backendProcess.HasExited -and -not $webProcess.HasExited) { Wait-Process -Id $backendProcess.Id -Timeout 2 -ErrorAction SilentlyContinue | Out-Null }
} finally {
    foreach ($process in @($backendProcess, $webProcess)) { if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } }
}
