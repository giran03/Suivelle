[CmdletBinding()]
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
# Only generated, project-local caches. Keep dependencies, dist, release EXEs,
# packaged installers, signing certificates, source, and app data.
$cachePaths = @(
    'node_modules\.vite', 'node_modules\.vite-temp', 'node_modules\.cache',
    'node_modules\.vitest', '.vite', '.vitest', '.cache', 'coverage',
    'src-tauri\target\debug',
    'src-tauri\target\release\build', 'src-tauri\target\release\deps',
    'src-tauri\target\release\incremental', 'src-tauri\target\release\.fingerprint',
    'src-tauri\target\release\examples', 'src-tauri\target\msix-staging'
)

try {
    foreach ($relativePath in $cachePaths) {
        $cachePath = [IO.Path]::GetFullPath((Join-Path $projectRoot $relativePath))
        if (-not $cachePath.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Unsafe cache path: $cachePath"
        }
        # Refuse junctions/symlinks in the path rather than deleting outside the project.
        $ancestor = $cachePath
        while ($ancestor -ne $projectRoot) {
            if (Test-Path -LiteralPath $ancestor) {
                if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                    throw "Refusing linked cache path: $ancestor"
                }
            }
            $ancestor = Split-Path -Parent $ancestor
        }
        if (Test-Path -LiteralPath $cachePath) {
            $linkedChild = Get-ChildItem -LiteralPath $cachePath -Force -Recurse -Attributes ReparsePoint |
                Select-Object -First 1
            if ($linkedChild) { throw "Refusing cache containing a link: $($linkedChild.FullName)" }
            if ($DryRun) { Write-Host "Would remove $relativePath" }
            else { Write-Host "Removing $relativePath" }
            if (-not $DryRun) { Remove-Item -LiteralPath $cachePath -Recurse -Force }
        }
    }
    if ($DryRun) { Write-Host 'Preview complete. No files were removed.' }
    else { Write-Host 'Cache cleanup complete. The next Rust build may take longer.' }
    exit 0
} catch {
    Write-Host "Cleanup failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Close running build/dev processes and retry if files are locked.'
    exit 1
}
