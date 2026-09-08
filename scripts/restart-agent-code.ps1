param([Parameter(Mandatory = $true)][string]$Manifest)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$directory = Split-Path -Parent ([IO.Path]::GetFullPath($Manifest))
function Mark([string]$name, [string]$value = '') {
    [IO.File]::WriteAllText((Join-Path $directory $name), $value)
}
function Canceled { return Test-Path -LiteralPath (Join-Path $directory 'cancel') }
function Identity([int]$processId) {
    $p = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($null -eq $p) { return $null }
    return @{ pid = $p.Id; path = $p.Path; created = ([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() }
}
function Same($expected) {
    $actual = Identity $expected.pid
    if ($null -eq $actual) { return $false }
    if ($actual.created -ne $expected.created -or $actual.path -ine $expected.path) {
        throw 'PID was reused or executable identity changed.'
    }
    return $true
}
try {
    # One-shot claim, even if the same manifest is launched twice.
    $claim = [IO.File]::Open((Join-Path $directory 'claim'), 'CreateNew', 'Write', 'None')
    $claim.Dispose()
    $r = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
    if ($r.mode -notin @('dev', 'portable')) { throw 'Unsupported launch mode.' }
    if ([long]$r.deadline -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) { throw 'Expired request.' }
    $target = @{ pid = [int]$r.targetPid; path = [string]$r.executable; created = [long]$r.createdAt }
    if (!(Same $target)) { throw 'Target must still be alive before arming.' }
    $launch = [IO.Path]::GetFullPath([string]$r.launch)
    if (!(Test-Path -LiteralPath $launch -PathType Leaf)) { throw 'Launch route is missing.' }
    $supervisor = $null
    if ($r.mode -eq 'dev') {
        $expected = Join-Path ([string]$r.appRoot) 'start.bat'
        if ($launch -ine [IO.Path]::GetFullPath($expected)) { throw 'Unrecognized dev route.' }
        $row = Get-CimInstance Win32_Process -Filter "ProcessId = $($target.pid)"
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($row.ParentProcessId)"
        $supervisor = Identity ([int]$row.ParentProcessId)
        $vite = Join-Path ([string]$r.appRoot) 'node_modules\electron-vite\bin\electron-vite.js'
        if ($null -eq $supervisor -or [IO.Path]::GetFileName($supervisor.path) -ine 'node.exe' -or
            $parent.CommandLine.Replace('/', '\').IndexOf($vite, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            throw 'Exact electron-vite parent supervisor could not be verified.'
        }
        # electron-vite exits normally on Electron close. Never kill a watcher.
    } else {
        if ([IO.Path]::GetExtension($launch) -ine '.exe' -or $launch -ieq $target.path) {
            throw 'Original portable executable was not identified (extracted Electron is not a launch route).'
        }
    }
    Mark 'armed'
    while (!(Test-Path -LiteralPath (Join-Path $directory 'commit'))) {
        if (Canceled) { throw 'Canceled before commit.' }
        if (!(Same $target)) { throw 'Target exited without authorization.' }
        if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -gt [long]$r.deadline) { throw 'Commit timed out.' }
        Start-Sleep -Milliseconds 50
    }
    if (Canceled) { throw 'Canceled before shutdown.' }
    if (!(Same $target)) { throw 'Target exited before commit acknowledgment.' }
    Mark 'committed'
    do {
        if (Canceled) { throw 'Canceled while awaiting normal shutdown.' }
        if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -gt [long]$r.deadline) { throw 'Normal shutdown timed out; no relaunch.' }
        $alive = Same $target
        $parentAlive = $false
        if ($null -ne $supervisor) { $parentAlive = Same $supervisor }
        if ($alive -or $parentAlive) { Start-Sleep -Milliseconds 100 }
    } while ($alive -or $parentAlive)
    if (Canceled) { throw 'Canceled before relaunch.' }
    if ($r.mode -eq 'dev') {
        $newProcess = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', ('""' + $launch + '""')) -WorkingDirectory ([string]$r.appRoot) -PassThru
    } else {
        $newProcess = Start-Process -FilePath $launch -WorkingDirectory (Split-Path -Parent $launch) -PassThru
    }
    Mark 'launched' ("PID=$($newProcess.Id); UTC=$([DateTime]::UtcNow.ToString('o'))")
} catch {
    Mark 'failure' $_.Exception.Message
    exit 1
}
