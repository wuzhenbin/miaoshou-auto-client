param(
    [string]$InstallRoot = $PSScriptRoot,
    [switch]$RemoveData
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $InstallRoot)) { Write-Host "未找到安装目录：$InstallRoot"; exit 0 }
Write-Host "将删除程序、依赖、日志和私有配置：$InstallRoot"
if ($RemoveData) { Write-Host '同时删除账号任务目录、图片、浏览器 profile 和本地运行数据。' }
$answer = Read-Host '输入 UNINSTALL 确认'
if ($answer -ne 'UNINSTALL') { Write-Host '已取消。'; exit 0 }
Get-Process node -ErrorAction SilentlyContinue | Where-Object {
    try { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -like "*$InstallRoot*" } catch { $false }
} | Stop-Process -Force -ErrorAction SilentlyContinue
foreach ($child in @('releases', 'private', 'logs')) {
    Remove-Item -LiteralPath (Join-Path $InstallRoot $child) -Recurse -Force -ErrorAction SilentlyContinue
}
if ($RemoveData) {
    Remove-Item -LiteralPath (Join-Path $HOME '.miaoshou-auto') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $HOME '.miaoshou-auto-accounts') -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host '原生 Windows 客户端已卸载。'
