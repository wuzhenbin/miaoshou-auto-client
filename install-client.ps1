$ErrorActionPreference = 'Stop'

function Show-Requirement([string]$message) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($message, 'Miaoshou Client', 'OK', 'Warning') | Out-Null
}

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    Show-Requirement 'WSL2 with Ubuntu is required. Install WSL2 and Ubuntu, then run this installer again.'
    exit 2
}

$distribution = $null
$names = & wsl.exe --list --quiet 2>$null
foreach ($entry in $names) {
    $name = ($entry -replace "`0", '').Trim()
    if (-not $name) { continue }
    $release = (& wsl.exe -d $name -- uname -r 2>$null | Out-String).Trim()
    $osRelease = (& wsl.exe -d $name -- cat /etc/os-release 2>$null | Out-String)
    if ($LASTEXITCODE -eq 0 -and $release -match 'WSL2' -and $osRelease -match '(?m)^ID=ubuntu\s*$') {
        $distribution = $name
        break
    }
}

if (-not $distribution) {
    Show-Requirement 'A working Ubuntu distribution on WSL2 is required. Install or initialize it, then run this installer again.'
    exit 2
}

$linuxSource = (& wsl.exe -d $distribution --exec wslpath -u $PSScriptRoot | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $linuxSource) { throw 'Cannot locate the release files in WSL2.' }
& wsl.exe -d $distribution --exec test -f "$linuxSource/deployment-manifest.json"
if ($LASTEXITCODE -ne 0) { throw 'The release files are not accessible from WSL2.' }
$linuxUser = (& wsl.exe -d $distribution --exec id -un | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $linuxUser -or $linuxUser -eq 'root') { throw 'Cannot identify the normal WSL user.' }
$nodePath = (& wsl.exe -d $distribution --exec bash -lc 'command -v node' | Out-String).Trim()
& wsl.exe -d $distribution -u root --exec bash "$linuxSource/install-client.sh" "$linuxSource" "$linuxUser" "$nodePath"
if ($LASTEXITCODE -ne 0) { throw 'Client installation in WSL2 failed. See the messages above.' }
$taskName = 'Miaoshou Client WSL'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

& wsl.exe -d $distribution --exec bash "$linuxSource/run-client.sh" "$linuxSource"
if ($LASTEXITCODE -ne 0) { throw 'Client stopped. See the messages above, then run run-client.cmd to restart.' }
