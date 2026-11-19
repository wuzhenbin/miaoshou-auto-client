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
& wsl.exe -d $distribution --exec bash "$linuxSource/install-client.sh" "$linuxSource"
if ($LASTEXITCODE -ne 0) { throw 'Client installation in WSL2 failed. See the messages above.' }
$taskName = 'Miaoshou Client WSL'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$url = 'http://127.0.0.1:8080/'
$apiUrl = 'http://127.0.0.1:8080/auth/session'
$arguments = '-d "{0}" --exec bash "{1}/run-client.sh" "{1}"' -f $distribution, $linuxSource
$runner = Start-Process -FilePath wsl.exe -ArgumentList $arguments -NoNewWindow -PassThru
try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ($runner.HasExited) { throw 'Client stopped during startup. See the messages above.' }
        try {
            $request = [System.Net.HttpWebRequest]::Create($url)
            $request.Proxy = $null
            $request.Timeout = 3000
            $response = $request.GetResponse()
            try { $ready = [int]$response.StatusCode -eq 200 } finally { $response.Close() }
            if ($ready) {
                $apiRequest = [System.Net.HttpWebRequest]::Create($apiUrl)
                $apiRequest.Proxy = $null
                $apiRequest.Timeout = 3000
                $apiResponse = $apiRequest.GetResponse()
                try { $ready = [int]$apiResponse.StatusCode -eq 200 } finally { $apiResponse.Close() }
                if ($ready) { break }
            }
        } catch { $ready = $false }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Client page or backend API did not become ready. See the messages above.' }
    Start-Process $url
    Write-Host "Client ready: $url"
    Write-Host 'Keep this window open while using the client.'
    $runner.WaitForExit()
    throw 'The client stopped. Run run-client.cmd to restart it.'
} finally {
    if (-not $runner.HasExited) {
        Stop-Process -Id $runner.Id -ErrorAction SilentlyContinue
    }
}
