# Profiles the whole Suivelle process tree (app + WebView2 children) through startup, visible idle,
# minimized idle and restore. Use an isolated build so the user's workspace is never touched:
#   $env:CARGO_TARGET_DIR = "$PWD\src-tauri\target-perf"
#   npm run tauri -- build --no-bundle --config .plans/performance.native.json
#   ./scripts/profile-native.ps1 -Label baseline
# Results are appended to .plans/native-profile.jsonl and printed as a table.
param(
    [string]$Exe = (Join-Path $PSScriptRoot '..\src-tauri\target-perf\release\Suivelle.exe'),
    [string]$Identifier = 'app.suivelle.performance',
    [string]$Label = 'run',
    [int]$StartupSeconds = 20,
    [int]$IdleSeconds = 120,
    [int]$MinimizedSeconds = 120,
    [int]$RestoredSeconds = 20,
    [int]$SampleMs = 1000
)
$ErrorActionPreference = 'Stop'
$Exe = (Resolve-Path $Exe).Path
$log = Join-Path $env:APPDATA "$Identifier\data\logs\suivelle.log"
if (Get-Process | Where-Object { $_.Path -eq $Exe }) { throw "Close the running profiling build first: $Exe" }

Add-Type -Namespace Native -Name User32 -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);'

function Get-Tree([int]$RootId) {
    $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine, WorkingSetSize, PrivatePageCount, ThreadCount, HandleCount, KernelModeTime, UserModeTime
    $children = @{}
    foreach ($p in $all) { $children[[int]$p.ParentProcessId] += @($p) }
    $byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
    if (!$byId.ContainsKey($RootId)) { return @() }
    $tree = [System.Collections.Generic.List[object]]::new(); $queue = [System.Collections.Generic.Queue[int]]::new()
    $tree.Add($byId[$RootId]); $queue.Enqueue($RootId)
    while ($queue.Count) { foreach ($c in @($children[$queue.Dequeue()])) { if ($c) { $tree.Add($c); $queue.Enqueue([int]$c.ProcessId) } } }
    return $tree
}

function Measure-Tree([int]$RootId) {
    $tree = Get-Tree $RootId
    $byKind = @{}
    foreach ($p in $tree) {
        $kind = if ($p.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } elseif ($p.Name -like 'msedgewebview2*') { 'browser' } else { 'app' }
        $byKind[$kind] = $byKind[$kind] + ($p.KernelModeTime + $p.UserModeTime) / 1e7
    }
    [pscustomobject]@{
        CpuByKind = $byKind
        Processes = $tree.Count
        WorkingSetMiB = [Math]::Round((($tree | Measure-Object WorkingSetSize -Sum).Sum) / 1MB, 1)
        PrivateMiB = [Math]::Round((($tree | Measure-Object PrivatePageCount -Sum).Sum) / 1MB, 1)
        Threads = ($tree | Measure-Object ThreadCount -Sum).Sum
        Handles = ($tree | Measure-Object HandleCount -Sum).Sum
        # 100 ns units -> seconds of CPU across every process in the tree.
        CpuSeconds = ((($tree | Measure-Object KernelModeTime -Sum).Sum) + (($tree | Measure-Object UserModeTime -Sum).Sum)) / 1e7
    }
}

function Watch-Phase([string]$Name, [int]$Seconds, [int]$RootId) {
    $samples = [System.Collections.Generic.List[object]]::new()
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $samples.Add((Measure-Tree $RootId)); Start-Sleep -Milliseconds $SampleMs
    }
    $last = $samples[$samples.Count - 1]
    [pscustomobject]@{
        Phase = $Name
        Seconds = $Seconds
        Processes = $last.Processes
        AvgWorkingSetMiB = [Math]::Round(($samples | Measure-Object WorkingSetMiB -Average).Average, 1)
        PeakWorkingSetMiB = ($samples | Measure-Object WorkingSetMiB -Maximum).Maximum
        EndPrivateMiB = $last.PrivateMiB
        EndThreads = $last.Threads
        EndHandles = $last.Handles
        # CPU used during the phase, as a share of one core.
        CpuPercentOfCore = [Math]::Round(100 * ($last.CpuSeconds - $samples[0].CpuSeconds) / [Math]::Max(1, $Seconds - $SampleMs / 1000), 2)
        # Which processes used that CPU: app (Rust), browser, renderer, gpu-process, utility.
        CpuByKind = ($last.CpuByKind.Keys | Sort-Object | ForEach-Object { '{0}={1:N2}' -f $_, (100 * ($last.CpuByKind[$_] - [double]$samples[0].CpuByKind[$_]) / [Math]::Max(1, $Seconds - $SampleMs / 1000)) }) -join ' '
    }
}

$logStart = if (Test-Path $log) { (Get-Item $log).Length } else { 0 }
$clock = [Diagnostics.Stopwatch]::StartNew()
$env:RUST_LOG = 'info'
$app = Start-Process -FilePath $Exe -PassThru
$windowMs = $null; $readyMs = $null
while ($clock.Elapsed.TotalSeconds -lt 30 -and ($null -eq $windowMs -or $null -eq $readyMs)) {
    $app.Refresh()
    if ($null -eq $windowMs -and $app.MainWindowHandle -ne 0) { $windowMs = $clock.ElapsedMilliseconds }
    if ($null -eq $readyMs -and (Test-Path $log)) {
        $stream = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
        try { [void]$stream.Seek($logStart, 'Begin'); $text = [IO.StreamReader]::new($stream).ReadToEnd() } finally { $stream.Dispose() }
        if ($text -match 'workspace database ready') { $readyMs = $clock.ElapsedMilliseconds }
    }
    Start-Sleep -Milliseconds 25
}

try {
    $phases = @(
        (Watch-Phase 'startup' $StartupSeconds $app.Id),
        (Watch-Phase 'idle-visible' $IdleSeconds $app.Id)
    )
    $app.Refresh(); [void][Native.User32]::ShowWindow($app.MainWindowHandle, 6)  # SW_MINIMIZE
    $phases += Watch-Phase 'minimized' $MinimizedSeconds $app.Id
    [void][Native.User32]::ShowWindow($app.MainWindowHandle, 9)  # SW_RESTORE
    $phases += Watch-Phase 'restored' $RestoredSeconds $app.Id
}
finally {
    $app.Refresh()
    if (!$app.HasExited) { [void]$app.CloseMainWindow(); if (!$app.WaitForExit(10000)) { Stop-Process -Id $app.Id -Force } }
}

$result = [pscustomobject]@{
    Label = $Label
    Date = (Get-Date).ToString('o')
    Commit = (git -C (Join-Path $PSScriptRoot '..') rev-parse --short HEAD)
    WindowHandleMs = $windowMs
    DatabaseReadyMs = $readyMs
    Phases = $phases
}
$out = Join-Path $PSScriptRoot '..\.plans\native-profile.jsonl'
($result | ConvertTo-Json -Depth 4 -Compress) | Add-Content -LiteralPath $out
"`n$Label  window: $windowMs ms  database ready: $readyMs ms"
$phases | Format-Table -AutoSize
