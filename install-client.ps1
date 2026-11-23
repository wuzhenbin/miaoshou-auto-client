$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 can promote native stderr warnings to terminating errors.
# WSL success is determined by its exit code; keep stderr available to callers.
function Invoke-Wsl {
    $ErrorActionPreference = 'Continue'
    $PSNativeCommandUseErrorActionPreference = $false
    & wsl.exe @args
    $global:LASTEXITCODE = $LASTEXITCODE
}


function Show-Requirement([string]$message) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($message, 'Miaoshou Client', 'OK', 'Warning') | Out-Null
}

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    Show-Requirement 'WSL2 with Ubuntu is required. Install WSL2 and Ubuntu, then run this installer again.'
    exit 2
}

$distribution = $null
$names = Invoke-Wsl --list --quiet 2>$null
foreach ($entry in $names) {
    $name = ($entry -replace "`0", '').Trim()
    if (-not $name) { continue }
    $release = (Invoke-Wsl -d $name -- uname -r 2>$null | Out-String).Trim()
    $kernelExitCode = $LASTEXITCODE
    $osRelease = (Invoke-Wsl -d $name -- cat /etc/os-release 2>$null | Out-String)
    if ($kernelExitCode -eq 0 -and $LASTEXITCODE -eq 0 -and $release -match 'WSL2' -and $osRelease -match '(?m)^ID=ubuntu\s*$') {
        $distribution = $name
        break
    }
}

if (-not $distribution) {
    Show-Requirement 'A working Ubuntu distribution on WSL2 is required. Install or initialize it, then run this installer again.'
    exit 2
}

$linuxSource = (Invoke-Wsl -d $distribution --exec wslpath -u $PSScriptRoot | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $linuxSource) { throw 'Cannot locate the release files in WSL2.' }
Invoke-Wsl -d $distribution --exec test -f "$linuxSource/deployment-manifest.json"
if ($LASTEXITCODE -ne 0) { throw 'The release files are not accessible from WSL2.' }
Invoke-Wsl -d $distribution --exec sed -i 's/\r$//' "$linuxSource/install-client.sh" "$linuxSource/install-client-user.sh" "$linuxSource/run-client.sh"
if ($LASTEXITCODE -ne 0) { throw 'Cannot normalize WSL2 shell scripts to Unix line endings.' }
$linuxUser = (Invoke-Wsl -d $distribution --exec id -un | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $linuxUser -or $linuxUser -eq 'root') { throw 'Cannot identify the normal WSL user.' }
$nodePath = (Invoke-Wsl -d $distribution --exec /bin/bash -lc 'command -v node' | Out-String).Trim()
Invoke-Wsl -d $distribution -u root --exec /bin/bash "$linuxSource/install-client.sh" "$linuxSource" "$linuxUser" "$nodePath"
if ($LASTEXITCODE -ne 0) { throw 'Client installation in WSL2 failed. See the messages above.' }
$taskName = 'Miaoshou Client WSL'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

Invoke-Wsl -d $distribution --exec /bin/bash "$linuxSource/run-client.sh" "$linuxSource"
if ($LASTEXITCODE -ne 0) { throw 'Client stopped. See the messages above, then run run-client.cmd to restart.' }
