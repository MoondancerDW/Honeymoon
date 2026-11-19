[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Destination,
    [string]$DownloadDirectory = (Join-Path ([IO.Path]::GetTempPath()) 'honeymoon-downloads'),
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$Revision,
    [string]$LodArchive,
    [ValidatePattern('^[0-9a-fA-F]{64}$')][string]$LodSha256,
    [switch]$SinglePlayer
)

$ErrorActionPreference = 'Stop'
$revision = $Revision.ToLowerInvariant()
$releaseUrl = 'https://github.com/MoondancerDW/Honeymoon/releases/download/alpha-2026-11-16'
$partHashes = [ordered]@{
    'Honeymoon-Alpha-Windows-x64.zip.001' = 'a3c95114570457c86f08f56f153c0321b94021420b79cdf18182de3b3402b8c8'
    'Honeymoon-Alpha-Windows-x64.zip.002' = 'de38ac4f03f939261a37970283a93abf206b4a43f87dc0e47657059683310ba2'
}
$portableFiles = @(
    'Start-Lilium-Moonlight.cmd', 'Start-Honeymoon.cmd', 'Start-Server.cmd', 'Start-Tailscale.cmd', 'Start-Internet.cmd',
    'Launch-Honeymoon.mjs', 'single-instance.mjs', 'Transfer-Honeymoon.mjs', 'Install-Honeymoon.ps1',
    'MIGRATION.md', 'ЧИТАЙ-МЕНЯ.txt', 'Review-PlayerNetwork.mjs', 'Watch-PlayerNetwork.mjs', 'solo-cache.mjs'
)

function Get-CheckedPath([string]$Path) {
    $fullPath = [IO.Path]::GetFullPath($Path)
    for ($item = $fullPath; $item; $item = [IO.Path]::GetDirectoryName($item)) {
        $entry = Get-Item -LiteralPath $item -Force -ErrorAction SilentlyContinue
        if ($entry -and ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing to use a reparse point: $item"
        }
    }
    return $fullPath
}

function Get-Download([string]$Name, [string]$Url, [string]$Hash) {
    $path = Get-CheckedPath (Join-Path $DownloadDirectory $Name)
    if (!(Test-Path -LiteralPath $path)) {
        $partial = $path + '.' + [guid]::NewGuid().ToString('N') + '.partial'
        try {
            Write-Host "Downloading $Name"
            & curl.exe --fail --location --retry 3 --output $partial $Url
            if ($LASTEXITCODE) { throw "Download failed: $Url" }
            if ($Hash -and (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ine $Hash) {
                throw "SHA-256 mismatch: $Name"
            }
            [IO.File]::Move($partial, $path)
        } finally {
            if ([IO.File]::Exists($partial)) { [IO.File]::Delete($partial) }
        }
    } elseif ($Hash -and (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $Hash) {
        throw "SHA-256 mismatch: $path. Remove that cached file or use another download directory."
    }
    return $path
}

function Get-RuntimePath([string]$Source) {
    if ($Source -cmatch '^project/(README\.md|package\.json)$') { return $Matches[1] }
    if ($SinglePlayer -and $Source -ceq 'project/portable/Launch-Singleplayer.mjs') { return 'Launch-Honeymoon.mjs' }
    if ($SinglePlayer -and $Source -ceq 'project/portable/SINGLEPLAYER.txt') { return 'ЧИТАЙ-МЕНЯ.txt' }
    if ($SinglePlayer -and $Source -cmatch '^project/portable/(?:Launch-Honeymoon\.mjs|ЧИТАЙ-МЕНЯ\.txt|Start-(?:Server|Internet|Tailscale)\.cmd)$') { return }
    if ($Source -cmatch '^project/portable/([^/]+)$' -and $Matches[1] -cin $portableFiles) { return $Matches[1] }
    if ($Source -cmatch '^project/((?:client|server|world)/.+\.(?:mjs|html|css|json|webmanifest|png|svg|webp))$' -and
        !$Source.EndsWith('.test.mjs', [StringComparison]::Ordinal)) { return $Matches[1] }
}

function Expand-Entry($Entry, [string]$Name) {
    foreach ($part in $Name.Split('/')) {
        if (!$part -or $part -match '^[. ]+$|[. ]$|[\\:<>\x00-\x1F"|?*]|^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
            throw "Invalid archive path: $Name"
        }
    }
    if (($Entry.ExternalAttributes -band 0x400) -or (($Entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
        throw "Unexpected link in archive: $($Entry.FullName)"
    }
    $path = Join-Path $staging ($Name.Replace('/', '\'))
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToFile($Entry, $path)
}

$Destination = Get-CheckedPath $Destination
$DownloadDirectory = Get-CheckedPath $DownloadDirectory
if ([bool]$LodArchive -ne [bool]$LodSha256) { throw 'Supply both -LodArchive and -LodSha256.' }
if ($LodArchive) {
    $LodArchive = Get-CheckedPath $LodArchive
    if ((Get-FileHash -LiteralPath $LodArchive -Algorithm SHA256).Hash -ine $LodSha256) { throw 'LOD archive checksum mismatch.' }
}
$destinationParent = [IO.Path]::GetDirectoryName($Destination)
if (!$destinationParent -or (Test-Path -LiteralPath $Destination)) { throw 'Choose a new destination directory.' }
if ($DownloadDirectory -ieq $Destination -or $DownloadDirectory.StartsWith(
        $Destination.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The download directory must be outside the destination.'
}
[IO.Directory]::CreateDirectory($destinationParent) | Out-Null
[IO.Directory]::CreateDirectory($DownloadDirectory) | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem

$parts = foreach ($part in $partHashes.Keys) { Get-Download $part "$releaseUrl/$part" $partHashes[$part] }
$sources = Get-Download "Honeymoon-$revision.zip" "https://codeload.github.com/MoondancerDW/Honeymoon/zip/$revision"
$id = [guid]::NewGuid().ToString('N')
$joined = Join-Path $DownloadDirectory "Honeymoon-$id.joined.zip"
$staging = Join-Path $destinationParent ".honeymoon-install-$id"

try {
    Write-Host 'Joining the verified Windows archive parts.'
    $combined = [IO.File]::Open($joined, [IO.FileMode]::CreateNew)
    try {
        foreach ($part in $parts) {
            $inputFile = [IO.File]::OpenRead($part)
            try { $inputFile.CopyTo($combined, 1048576) } finally { $inputFile.Dispose() }
        }
    } finally { $combined.Dispose() }

    Write-Host "Installing map, assets and Node.js into staging at $staging"
    [IO.Directory]::CreateDirectory($staging) | Out-Null
    $base = [IO.Compression.ZipFile]::OpenRead($joined)
    try {
        foreach ($entry in $base.Entries) {
            if ($entry.Name -and $entry.FullName -cmatch '^(generated|runtime|node_modules)/') {
                if ($LodArchive -and $entry.FullName -cmatch '^generated/lod/') { continue }
                Expand-Entry $entry $entry.FullName
            }
        }
    } finally { $base.Dispose() }
    if ($LodArchive) {
        $rebuilt = [IO.Compression.ZipFile]::OpenRead($LodArchive)
        try {
            foreach ($entry in $rebuilt.Entries) {
                if (!$entry.Name) { continue }
                if ($entry.FullName -cnotmatch '^generated/lod/(?:manifest\.json|-?\d+\.-?\d+(?:\.outer)?\.bin(?:\.gz)?)$') {
                    throw 'Unexpected file in the LOD archive.'
                }
                Expand-Entry $entry $entry.FullName
            }
            foreach ($file in Get-ChildItem -LiteralPath (Join-Path $staging 'generated/lod') -Filter '*.bin.gz' -File) {
                $rawPath = $file.FullName.Substring(0, $file.FullName.Length - 3)
                if ([IO.File]::Exists($rawPath)) { continue }
                $compressed = $file.OpenRead()
                try {
                    $decoder = New-Object IO.Compression.GZipStream($compressed, [IO.Compression.CompressionMode]::Decompress)
                    try {
                        $raw = [IO.File]::Open($rawPath, [IO.FileMode]::CreateNew)
                        try { $decoder.CopyTo($raw) } finally { $raw.Dispose() }
                    } finally { $decoder.Dispose() }
                } finally { $compressed.Dispose() }
            }
        } finally { $rebuilt.Dispose() }
    }

    Write-Host "Installing committed runtime $revision"
    $sourceZip = [IO.Compression.ZipFile]::OpenRead($sources)
    try {
        $prefix = "Honeymoon-$revision/"
        $runtime = @{}
        foreach ($entry in $sourceZip.Entries) {
            if (!$entry.FullName.StartsWith($prefix, [StringComparison]::Ordinal)) { throw 'Unexpected source ZIP root.' }
            $name = Get-RuntimePath $entry.FullName.Substring($prefix.Length)
            if (!$name) { continue }
            if ($runtime.ContainsKey($name)) { throw "Duplicate runtime file: $name" }
            $runtime[$name] = $true
            Expand-Entry $entry $name
        }
    } finally { $sourceZip.Dispose() }
    foreach ($required in @('Start-Honeymoon.cmd', 'Launch-Honeymoon.mjs', 'single-instance.mjs', 'package.json',
            'runtime/node.exe', 'node_modules/three/build/three.module.js', 'server/index.mjs', 'client/index.html',
            'generated/world/world.json', 'generated/full-world/manifest.json', 'generated/lod/manifest.json',
            'generated/textures/atlas.png', 'generated/npcs/models.json', 'generated/npcs/original.json',
            'generated/vista/manifest.json', 'generated/weather/biomes.bin', 'generated/creative/catalog.json')) {
        if (![IO.File]::Exists((Join-Path $staging $required))) { throw "Missing installation file: $required" }
    }
    [IO.Directory]::Move($staging, $Destination)
    $launcher = if (Test-Path -LiteralPath (Join-Path $Destination 'Start-Lilium-Moonlight.cmd')) {
        'Start-Lilium-Moonlight.cmd'
    } else {
        'Start-Honeymoon.cmd'
    }
    Write-Host "Lilium Moonlight installed at $Destination. Run $launcher there."
} catch {
    if ([IO.Directory]::Exists($staging)) { Write-Warning "The incomplete staging directory remains at $staging" }
    throw
} finally {
    if ([IO.File]::Exists($joined)) { [IO.File]::Delete($joined) }
}
