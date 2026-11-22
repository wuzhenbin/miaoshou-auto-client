param([string]$Source = $PSScriptRoot, [string]$InstallRoot = '')
$ErrorActionPreference = 'Stop'
if (-not $InstallRoot) { $InstallRoot = $Source }

function Fail([string]$message) { Write-Error $message; exit 2 }
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { Fail '原生 Windows 客户端需要 Node.js 22.19.0 或更高版本。' }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { Fail '未找到 npm，请安装与 Node.js 匹配的 npm。' }
if (-not (Get-Command pg_isready.exe -ErrorAction SilentlyContinue) -or -not (Get-Command psql.exe -ErrorAction SilentlyContinue)) {
    Fail '原生 Windows 客户端需要已安装并加入 PATH 的 PostgreSQL 客户端工具（pg_isready、psql）及 pgvector 服务端扩展。'
}
& pg_isready.exe -h 127.0.0.1 -p 5432 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'PostgreSQL 127.0.0.1:5432 未就绪，请先启动 Windows PostgreSQL 服务。' }
$manifest = Join-Path $Source 'deployment-manifest.json'
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { Fail '缺少 deployment-manifest.json，请使用完整客户端产物。' }
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifest).Hash.Substring(0,16).ToLowerInvariant()
$release = Join-Path $InstallRoot "releases\$hash"
$privateRoot = Join-Path $InstallRoot 'private'
$config = Join-Path $privateRoot 'client.env'
New-Item -ItemType Directory -Force -Path $privateRoot | Out-Null
& node.exe (Join-Path $Source 'install-client.mjs') prepare $Source $release
if (-not (Test-Path (Join-Path $release '.install-complete'))) {
    Push-Location (Join-Path $release 'backend')
    try {
        & npm.cmd ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { Fail '原生 Windows 生产依赖安装失败。' }
        & npx.cmd playwright install chromium
        if ($LASTEXITCODE -ne 0) { Fail 'Playwright Chromium 安装失败。' }
    } finally { Pop-Location }
    if (-not (Test-Path $config)) { & node.exe (Join-Path $release 'install-client.mjs') configure $config }
$dbPassword = (& node.exe (Join-Path $release 'install-client.mjs') db-password $config | Out-String).Trim()
$adminUser = Read-Host 'PostgreSQL 管理用户（默认 postgres）'
if (-not $adminUser) { $adminUser = 'postgres' }
$adminPassword = Read-Host 'PostgreSQL 管理密码（可留空，使用本机信任认证）' -AsSecureString
$adminCredential = New-Object System.Management.Automation.PSCredential($adminUser, $adminPassword)
$plainAdminPassword = $adminCredential.GetNetworkCredential().Password
$oldPassword = $env:PGPASSWORD
try {
    if ($plainAdminPassword) { $env:PGPASSWORD = $plainAdminPassword } else { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
    $sql = "DO `$`$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miaoshou_client') THEN ALTER ROLE miaoshou_client WITH LOGIN PASSWORD '$dbPassword'; ELSE CREATE ROLE miaoshou_client LOGIN PASSWORD '$dbPassword'; END IF; END `$`$;"
    & psql.exe -h 127.0.0.1 -U $adminUser -d postgres -v ON_ERROR_STOP=1 -c $sql
    if ($LASTEXITCODE -ne 0) { Fail '无法使用 PostgreSQL 管理凭据创建 miaoshou_client 角色。' }
} finally {
    if ($null -eq $oldPassword) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue } else { $env:PGPASSWORD = $oldPassword }
}
    New-Item -ItemType File -Force -Path (Join-Path $release '.install-complete') | Out-Null
}
if (-not (Test-Path $config)) { & node.exe (Join-Path $release 'install-client.mjs') configure $config }
& (Join-Path $release 'run-client-native.ps1') -Release $release -Config $config -InstallRoot $InstallRoot
