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

& wsl.exe -d $distribution --exec systemctl cat miaoshou-client-backend.service *> $null
$backendInstalled = $LASTEXITCODE -eq 0
& wsl.exe -d $distribution --exec systemctl cat miaoshou-client-web.service *> $null
$webInstalled = $LASTEXITCODE -eq 0

if ($backendInstalled -and $webInstalled) {
    & wsl.exe -d $distribution --exec systemctl is-active --quiet miaoshou-client-backend.service
    $backendActive = $LASTEXITCODE -eq 0
    & wsl.exe -d $distribution --exec systemctl is-active --quiet miaoshou-client-web.service
    $webActive = $LASTEXITCODE -eq 0
    if (-not ($backendActive -and $webActive)) {
        & wsl.exe -d $distribution --exec sudo systemctl start miaoshou-client-backend.service miaoshou-client-web.service
        if ($LASTEXITCODE -ne 0) { throw 'Cannot start the installed client services in WSL2.' }
    }
} else {
    $linuxSource = (& wsl.exe -d $distribution --exec wslpath -u $PSScriptRoot | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $linuxSource) { throw 'Cannot locate the release files in WSL2.' }
    & wsl.exe -d $distribution --exec test -f "$linuxSource/deployment-manifest.json"
    if ($LASTEXITCODE -ne 0) { throw 'The release files are not accessible from WSL2.' }
    & wsl.exe -d $distribution --exec bash "$linuxSource/install-client.sh" "$linuxSource"
    if ($LASTEXITCODE -ne 0) { throw 'Client installation in WSL2 failed. See the messages above.' }

    $taskName = 'Miaoshou Client WSL'
    if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
        $action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wsl.exe" -Argument "-d `"$distribution`" --exec /bin/sleep infinity"
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
        $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal | Out-Null
    }
    Start-ScheduledTask -TaskName $taskName
}

$keepAlive = Start-Process -FilePath "$env:WINDIR\System32\wsl.exe" -ArgumentList "-d `"$distribution`" --exec /bin/sleep infinity" -NoNewWindow -PassThru
$url = 'http://127.0.0.1:8080/workbench'
try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ($keepAlive.HasExited) { throw 'The WSL2 keepalive process stopped unexpectedly.' }
        try {
            $request = [System.Net.HttpWebRequest]::Create($url)
            $request.Proxy = $null
            $request.Timeout = 3000
            $response = $request.GetResponse()
            try { $ready = [int]$response.StatusCode -eq 200 } finally { $response.Close() }
            if ($ready) { break }
        } catch { Start-Sleep -Seconds 1 }
    }
    if ($ready) {
        Start-Process $url
        Write-Host "Client ready: $url"
    } else {
        Write-Warning "The client is running in WSL2, but Windows cannot reach $url. Check WSL2 localhost forwarding."
    }
    Write-Host 'Keep this window open while using the client.'
    $keepAlive.WaitForExit()
    throw 'The WSL2 keepalive process stopped; run run-client.cmd to restart the client.'
} finally {
    if (-not $keepAlive.HasExited) { Stop-Process -Id $keepAlive.Id -Force }
}
