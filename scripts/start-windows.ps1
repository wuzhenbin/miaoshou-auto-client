$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$version = '22.19.0'
$runtimeRoot = Join-Path $env:USERPROFILE '.miaoshou-auto\client-runtime\node'
$nodeExe = $null

$systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
if ($systemNode) {
    $installed = & $systemNode.Source -p 'process.versions.node'
    $parts = [version]$installed
    if ($parts -ge [version]'22.19.0') { $nodeExe = $systemNode.Source }
}

if (-not $nodeExe) {
    if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [System.Runtime.InteropServices.Architecture]::X64) {
        throw 'This launcher supports Windows x64 only.'
    }
    $folder = "node-v$version-win-x64"
    $nodeExe = Join-Path $runtimeRoot "$folder\node.exe"
    if (-not (Test-Path $nodeExe)) {
        $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("miaoshou-node-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tempDir | Out-Null
        try {
            $archive = "$folder.zip"
            $baseUrl = "https://nodejs.org/dist/v$version"
            $hashList = Join-Path $tempDir 'SHASUMS256.txt'
            $zipPath = Join-Path $tempDir $archive
            Write-Host "Downloading Node.js $version..."
            Invoke-WebRequest "$baseUrl/SHASUMS256.txt" -OutFile $hashList
            Invoke-WebRequest "$baseUrl/$archive" -OutFile $zipPath
            $line = Get-Content $hashList | Where-Object { $_ -match "^[a-fA-F0-9]{64}\s+$([regex]::Escape($archive))$" } | Select-Object -First 1
            if (-not $line) { throw 'Node.js checksum list does not contain the archive.' }
            $expected = ($line -split '\s+')[0]
            $actual = (Get-FileHash $zipPath -Algorithm SHA256).Hash
            if ($expected -ine $actual) { throw 'Node.js archive checksum verification failed.' }
            New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
            Expand-Archive $zipPath -DestinationPath $runtimeRoot -Force
        } finally {
            Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

& $nodeExe (Join-Path $PSScriptRoot 'run-local.mjs')
exit $LASTEXITCODE
