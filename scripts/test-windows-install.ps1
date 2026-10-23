$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Run the installer acceptance check on Windows.' }
$package = Get-Content package.json -Raw | ConvertFrom-Json
$installer = Join-Path (Get-Location) "release/IntelBoard-$($package.version)-win-x64.exe"
$installDir = Join-Path ([IO.Path]::GetTempPath()) ("intelboard-install-" + [guid]::NewGuid().ToString('N'))
$previousBinary = $env:INTELBOARD_TEST_BINARY
try {
    $process = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Installer exited with $($process.ExitCode)" }
    $binary = Join-Path $installDir 'IntelBoard.exe'
    if (-not (Test-Path $binary)) { throw 'Installer did not create IntelBoard.exe.' }
    $env:INTELBOARD_TEST_BINARY = $binary
    node scripts/smoke-desktop.js
    if ($LASTEXITCODE -ne 0) { throw 'Installed application smoke check failed.' }
    Write-Output 'Windows installer and installed application passed.'
} finally {
    $env:INTELBOARD_TEST_BINARY = $previousBinary
    $uninstaller = Join-Path $installDir 'Uninstall IntelBoard.exe'
    if (Test-Path $uninstaller) {
        $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
        if ($process.ExitCode -ne 0) { Write-Warning "Uninstaller exited with $($process.ExitCode)" }
    }
    for ($attempt = 0; $attempt -lt 10 -and (Test-Path $installDir); $attempt++) {
        try { Remove-Item -LiteralPath $installDir -Recurse -Force } catch { Start-Sleep -Milliseconds 300 }
    }
}
