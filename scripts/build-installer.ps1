[CmdletBinding()]
param(
    [ValidateSet('nsis', 'msix')][string]$Format,
    # Accepted for compatibility with older commands; packaging never opens an installer.
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot

function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed (exit $LASTEXITCODE)." }
}

function Find-SdkTool([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $versions = Get-ChildItem -LiteralPath $sdkRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^10\.0\.\d+\.0$' } |
        Sort-Object { [version]$_.Name } -Descending
    foreach ($version in $versions) {
        $tool = Join-Path $version.FullName "x64\$Name"
        if (Test-Path -LiteralPath $tool) { return $tool }
    }
    throw "Install the Windows 10/11 SDK (including $Name) to build MSIX packages."
}

try {
    if (-not $Format) {
        Write-Host '1. NSIS setup.exe (recommended, smallest installer)'
        Write-Host '2. MSIX (Windows SDK + signing certificate required)'
        $selection = Read-Host 'Choose 1 or 2 [1]'
        switch ($selection.Trim()) {
            '' { $Format = 'nsis' }
            '1' { $Format = 'nsis' }
            '2' { $Format = 'msix' }
            default { throw 'Choose 1 or 2.' }
        }
    }
    foreach ($tool in @('npm.cmd', 'cargo.exe', 'rustc.exe')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Missing prerequisite: $tool" }
    }
    if ($env:CARGO_TARGET_DIR -or $env:CARGO_BUILD_TARGET) {
        throw 'Unset CARGO_TARGET_DIR and CARGO_BUILD_TARGET so installers use the project-local release output.'
    }
    # Both packages and the existing launcher use the normal Windows x64 release directory.
    $rustInfo = & rustc.exe -vV
    if ($LASTEXITCODE -ne 0 -or $rustInfo -notcontains 'host: x86_64-pc-windows-msvc') {
        throw 'These installer scripts require the Windows x64 MSVC Rust toolchain.'
    }
    if ($Format -eq 'msix') {
        $makeappx = Find-SdkTool 'makeappx.exe'
        $signtool = Find-SdkTool 'signtool.exe'
    }
    if (-not (Test-Path -LiteralPath 'node_modules\@tauri-apps\cli\tauri.js')) {
        Invoke-Checked 'npm.cmd' @('ci')
    }
    $config = Get-Content -LiteralPath 'src-tauri\tauri.conf.json' -Raw | ConvertFrom-Json
    $executableName = "$($config.mainBinaryName).exe"
    $releaseRoot = Join-Path $projectRoot 'src-tauri\target\release'
    $bundleRoot = Join-Path $releaseRoot 'bundle'
    $buildStarted = Get-Date
    if ($Format -eq 'nsis') {
        Invoke-Checked 'npm.cmd' @('run', 'tauri', '--', 'build', '--bundles', 'nsis')
        $installer = Get-ChildItem -LiteralPath (Join-Path $bundleRoot 'nsis') -Filter '*-setup.exe' |
            Where-Object { $_.LastWriteTime -ge $buildStarted } |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $installer) { throw 'Build completed without a fresh NSIS installer.' }
        $installerPath = $installer.FullName
    } else {
        Invoke-Checked 'npm.cmd' @('run', 'tauri', '--', 'build', '--no-bundle')
        $identity = $config.identifier
        $certificateSubject = 'CN=Suivelle Local Development'
        if ($env:SUIVELLE_MSIX_CERT_THUMBPRINT) {
            $certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$env:SUIVELLE_MSIX_CERT_THUMBPRINT"
        } else {
            $certificate = Get-ChildItem Cert:\CurrentUser\My |
                Where-Object { $_.Subject -eq $certificateSubject -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date).AddDays(7) } |
                Sort-Object NotAfter -Descending | Select-Object -First 1
            if (-not $certificate) {
                $certificate = New-SelfSignedCertificate -Type Custom -Subject $certificateSubject `
                    -FriendlyName 'Suivelle local MSIX signing' -CertStoreLocation Cert:\CurrentUser\My `
                    -KeyUsage DigitalSignature -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
                    -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddYears(2) `
                    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
            }
        }
        if (-not $certificate.HasPrivateKey -or $certificate.NotAfter -le (Get-Date) -or $certificate.NotBefore -gt (Get-Date)) {
            throw 'The MSIX signing certificate needs a private key and a valid lifetime.'
        }
        $parts = $config.version.Split('.')
        if ($parts.Count -ne 3 -or ($parts | Where-Object { $_ -notmatch '^\d+$' -or [int]$_ -gt 65535 })) {
            throw 'MSIX requires a numeric major.minor.patch version with each part <= 65535.'
        }
        $version = "$($config.version).0"
        # A unique staging directory prevents stale/debug files entering the package.
        $stagingRoot = Join-Path $projectRoot 'src-tauri\target\msix-staging'
        $staging = Join-Path $stagingRoot ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path (Join-Path $staging 'Assets') -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $releaseRoot $executableName) -Destination $staging
        foreach ($icon in @('Square44x44Logo.png', 'Square150x150Logo.png', 'StoreLogo.png')) {
            Copy-Item -LiteralPath (Join-Path $projectRoot "src-tauri\icons\$icon") -Destination (Join-Path $staging 'Assets')
        }
        # Frontend files are already embedded by Tauri. Never include target/deps or PDBs.
        if ($config.bundle.resources -or $config.bundle.externalBin) {
            throw 'MSIX staging must be updated to include the newly configured resources/sidecars.'
        }
        $displayName = [Security.SecurityElement]::Escape($config.productName)
        $publisher = [Security.SecurityElement]::Escape($certificate.Subject)
        $manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
 xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
 xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
 IgnorableNamespaces="uap rescap">
 <Identity Name="$identity" Publisher="$publisher" Version="$version" ProcessorArchitecture="x64" />
 <Properties><DisplayName>$displayName</DisplayName><PublisherDisplayName>$displayName</PublisherDisplayName><Logo>Assets\StoreLogo.png</Logo></Properties>
 <Resources><Resource Language="en-us" /></Resources>
 <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" /></Dependencies>
 <Applications><Application Id="App" Executable="$executableName" EntryPoint="Windows.FullTrustApplication">
  <uap:VisualElements DisplayName="$displayName" Description="$displayName" BackgroundColor="transparent"
   Square150x150Logo="Assets\Square150x150Logo.png" Square44x44Logo="Assets\Square44x44Logo.png" />
 </Application></Applications>
 <Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>
</Package>
"@
        [IO.File]::WriteAllText((Join-Path $staging 'AppxManifest.xml'), $manifest, [Text.UTF8Encoding]::new($false))
        $output = Join-Path $bundleRoot 'msix'
        New-Item -ItemType Directory -Path $output -Force | Out-Null
        $installerPath = Join-Path $output "$($config.productName)_$version`_x64.msix"
        Invoke-Checked $makeappx @('pack', '/d', $staging, '/p', $installerPath, '/o')
        Invoke-Checked $signtool @('sign', '/fd', 'SHA256', '/sha1', $certificate.Thumbprint, '/s', 'My', $installerPath)
        $certificatePath = Join-Path $output 'Suivelle-signing.cer'
        Export-Certificate -Cert $certificate -FilePath $certificatePath -Force | Out-Null
        Write-Host "Public signing certificate: $certificatePath"
        Write-Host 'For distribution, use a trusted signing certificate; the default certificate is for local testing.'
    }

    $size = (Get-Item -LiteralPath $installerPath).Length / 1MB
    Write-Host ("Built: {0} ({1:N2} MiB)" -f $installerPath, $size) -ForegroundColor Green
    Write-Host 'Packaging complete. Open the installer manually when ready.'
    exit 0
} catch {
    Write-Host "Build/package failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($staging -and (Test-Path -LiteralPath $staging)) {
        # Generated GUID child only; never delete the entire target/output tree.
        $resolvedStaging = [IO.Path]::GetFullPath($staging)
        if ($resolvedStaging.StartsWith($stagingRoot + '\', [StringComparison]::OrdinalIgnoreCase) -and
            -not ((Get-Item -LiteralPath $resolvedStaging -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
        }
    }
}
