$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$distDir = Join-Path $projectRoot "dist"
$outputPath = Join-Path $distDir "obsidian-scholar-bridge-0.8.1.xpi"

New-Item -ItemType Directory -Force -Path $distDir | Out-Null
if (Test-Path -LiteralPath $outputPath) {
  Remove-Item -LiteralPath $outputPath
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$included = @(
  "manifest.json",
  "bootstrap.js",
  "prefs.js",
  "chrome",
  "locale",
  "LICENSE"
)

# Build only from the explicit allowlist above. Entry names are derived from
# allowlist roots rather than absolute-path string subtraction, so Windows
# PowerShell and PowerShell 7 produce the same XPI layout.
$archiveFiles = @()
foreach ($name in $included) {
  $sourcePath = Join-Path $projectRoot $name
  if (-not (Test-Path -LiteralPath $sourcePath)) {
    throw "Required package source is missing: $name"
  }
  $item = Get-Item -LiteralPath $sourcePath
  if (-not $item.PSIsContainer) {
    $archiveFiles += [pscustomobject]@{
      Source = $item.FullName
      Entry = $name.Replace("\", "/")
    }
    continue
  }
  $directoryRoot = $item.FullName.TrimEnd([char[]]"\/")
  Get-ChildItem -LiteralPath $directoryRoot -Recurse -File | ForEach-Object {
    $relativePath = $_.FullName.Substring($directoryRoot.Length).TrimStart([char[]]"\/")
    $archiveFiles += [pscustomobject]@{
      Source = $_.FullName
      Entry = ($name.TrimEnd([char[]]"\/") + "/" + $relativePath.Replace("\", "/"))
    }
  }
}

$outputStream = [System.IO.File]::Open(
  $outputPath,
  [System.IO.FileMode]::CreateNew,
  [System.IO.FileAccess]::Write,
  [System.IO.FileShare]::None
)
try {
  $archive = New-Object System.IO.Compression.ZipArchive(
    $outputStream,
    [System.IO.Compression.ZipArchiveMode]::Create,
    $false
  )
  try {
    foreach ($archiveFile in $archiveFiles) {
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive,
        $archiveFile.Source,
        $archiveFile.Entry,
        [System.IO.Compression.CompressionLevel]::Optimal
      ) | Out-Null
    }
  } finally {
    $archive.Dispose()
  }
} finally {
  $outputStream.Dispose()
}

Write-Output $outputPath
