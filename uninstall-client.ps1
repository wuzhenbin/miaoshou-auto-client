param([switch]$RemoveData)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { throw '未找到 WSL2。' }
$distribution = $null
foreach ($entry in (& wsl.exe --list --quiet 2>$null)) {
    $name = ($entry -replace "`0", '').Trim()
    if (-not $name) { continue }
    $release = (& wsl.exe -d $name -- uname -r 2>$null | Out-String).Trim()
    $osRelease = (& wsl.exe -d $name -- cat /etc/os-release 2>$null | Out-String)
    if ($LASTEXITCODE -eq 0 -and $release -match 'WSL2' -and $osRelease -match '(?m)^ID=ubuntu\s*$') { $distribution = $name; break }
}
if (-not $distribution) { throw '未找到可用的 WSL2 Ubuntu。' }
$script = (& wsl.exe -d $distribution --exec wslpath -u $PSScriptRoot | Out-String).Trim()
if (-not $script) { throw '无法定位 WSL2 卸载脚本。' }
$args = @($script + '/uninstall-client.sh')
if ($RemoveData) { $args += '--remove-data' }
& wsl.exe -d $distribution --exec /bin/bash @args
if ($LASTEXITCODE -ne 0) { throw 'WSL2 客户端卸载失败。' }
