$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$distDir = Join-Path $projectRoot "dist"
$outputPath = Join-Path $distDir "obsidian-scholar-bridge-0.8.0.xpi"

New-Item -ItemType Directory -Force -Path $distDir | Out-Null
if (Test-Path -LiteralPath $outputPath) {
  Remove-Item -LiteralPath $outputPath
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$temporaryDir = Join-Path $env:TEMP ("obsidian-scholar-bridge-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temporaryDir | Out-Null

try {
  $included = @(
    "manifest.json",
    "bootstrap.js",
    "prefs.js",
    "chrome",
    "locale",
    "LICENSE"
  )
  foreach ($name in $included) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination $temporaryDir -Recurse
  }
  # XPI/ZIP entry names must use forward slashes even when built on Windows.
  # ZipFile.CreateFromDirectory() preserves Windows backslashes in this runtime,
  # which makes Zotero unable to resolve manifest resources inside the archive.
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
      $archiveRoot = [string](Resolve-Path -LiteralPath $temporaryDir).Path
      $archivePrefix = $archiveRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) +
        [System.IO.Path]::DirectorySeparatorChar
      Get-ChildItem -LiteralPath $temporaryDir -Recurse -File | ForEach-Object {
        $relativePath = $_.FullName.Substring($archivePrefix.Length).TrimStart([char[]]"\/")
        $entryName = $relativePath.Replace("\", "/")
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
          $archive,
          $_.FullName,
          $entryName,
          [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
      }
    } finally {
      $archive.Dispose()
    }
  } finally {
    $outputStream.Dispose()
  }
} finally {
  if (Test-Path -LiteralPath $temporaryDir) {
    Remove-Item -LiteralPath $temporaryDir -Recurse -Force
  }
}

Write-Output $outputPath
