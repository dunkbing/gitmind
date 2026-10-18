# Installs the latest gitmind release on Windows:
#   irm https://gitmind.app/install.ps1 | iex
# Set $env:GITMIND_INSTALL_DIR to install somewhere other than
# %LOCALAPPDATA%\gitmind\bin.
$ErrorActionPreference = 'Stop'

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
$asset = "gitmind_windows_$arch.zip"
$base = 'https://github.com/dunkbing/gitmind/releases/latest/download'
$dir = if ($env:GITMIND_INSTALL_DIR) { $env:GITMIND_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'gitmind\bin' }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("gitmind-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    Write-Host "Downloading $asset..."
    Invoke-WebRequest -UseBasicParsing "$base/$asset" -OutFile (Join-Path $tmp $asset)
    Invoke-WebRequest -UseBasicParsing "$base/checksums.txt" -OutFile (Join-Path $tmp 'checksums.txt')

    $line = Get-Content (Join-Path $tmp 'checksums.txt') | Where-Object { ($_ -split '\s+')[1] -eq $asset }
    if (-not $line) { throw "checksums.txt has no entry for $asset" }
    $want = ($line -split '\s+')[0].ToLower()
    $got = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $asset)).Hash.ToLower()
    if ($got -ne $want) { throw "the download of $asset doesn't match its checksum; not installing it" }

    Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath (Join-Path $tmp 'x') -Force
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $exe = Join-Path $dir 'gitmind.exe'
    # A running gitmind.exe can't be overwritten, but it can be renamed.
    if (Test-Path $exe) { Move-Item -Force $exe "$exe.old" }
    Copy-Item (Join-Path $tmp 'x\gitmind.exe') $exe
    Write-Host "Installed $exe"

    $path = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (($path -split ';') -contains $dir)) {
        [Environment]::SetEnvironmentVariable('Path', ($path.TrimEnd(';') + ";$dir").TrimStart(';'), 'User')
        $env:Path += ";$dir"
        Write-Host "Added $dir to your PATH (open a new terminal to pick it up)."
    }
    Write-Host "Next: gitmind setup"
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
