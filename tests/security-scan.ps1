$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$excludedDirectories = @("node_modules", ".git")
$textExtensions = @(
  ".cjs", ".css", ".ftl", ".html", ".js", ".json", ".md", ".ps1", ".svg", ".txt", ".xhtml", ".yml", ".yaml"
)
$forbiddenFilePatterns = @(
  '^\.env($|\.)',
  '\.(pem|key|p12|pfx)$',
  '^(credentials|secrets?)(\.|$)',
  '^logins\.json$'
)
$contentRules = @(
  @{ Name = "GitHub token"; Pattern = 'gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}' },
  @{ Name = "OpenAI-style secret"; Pattern = 'sk-[A-Za-z0-9_-]{16,}' },
  @{ Name = "Google API key"; Pattern = 'AIza[A-Za-z0-9_-]{20,}' },
  @{ Name = "Slack token"; Pattern = 'xox[baprs]-[A-Za-z0-9-]{10,}' },
  @{ Name = "private key"; Pattern = '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----' },
  @{ Name = "authorization bearer value"; Pattern = '(?i)Bearer\s+[A-Za-z0-9._-]{20,}' },
  @{ Name = "real Windows user path"; Pattern = '(?i)C:\\Users\\(?!Researcher\\|Public\\|USERNAME\\|<[^>]+>\\)[^\\\r\n]+\\' },
  @{ Name = "personal email"; Pattern = '(?i)\b[A-Z0-9._%+-]+@(?!users\.noreply\.github\.com\b|example\.(com|org)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b' }
)

function Test-RelativePath {
  param([string]$RelativePath)
  $segments = $RelativePath -split '[/\\]'
  foreach ($segment in $segments) {
    if ($excludedDirectories -contains $segment) { return $false }
  }
  return $true
}

function Test-TextContent {
  param(
    [string]$DisplayPath,
    [string]$Content
  )
  $findings = @()
  foreach ($rule in $contentRules) {
    if ($Content -match $rule.Pattern) {
      $findings += "${DisplayPath}: $($rule.Name)"
    }
  }
  return $findings
}

$findings = @()
$projectPrefix = ([string](Resolve-Path -LiteralPath $projectRoot)).TrimEnd([System.IO.Path]::DirectorySeparatorChar) +
  [System.IO.Path]::DirectorySeparatorChar
$files = Get-ChildItem -LiteralPath $projectRoot -Recurse -File
foreach ($file in $files) {
  $relativePath = $file.FullName.Substring($projectPrefix.Length).Replace("\", "/")
  if (-not (Test-RelativePath $relativePath)) { continue }
  if ($relativePath -like "dist/*") { continue }
  foreach ($pattern in $forbiddenFilePatterns) {
    if ($file.Name -match $pattern) {
      $findings += "${relativePath}: forbidden credential-bearing filename"
    }
  }
  if ($textExtensions -notcontains $file.Extension.ToLowerInvariant()) { continue }
  $content = Get-Content -Raw -Encoding UTF8 -LiteralPath $file.FullName
  $findings += Test-TextContent -DisplayPath $relativePath -Content $content
}

$xpiFiles = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot "dist") -Filter "*.xpi" -File -ErrorAction SilentlyContinue)
if ($xpiFiles.Count -gt 0) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  foreach ($xpi in $xpiFiles) {
    $archive = [System.IO.Compression.ZipFile]::OpenRead($xpi.FullName)
    try {
      foreach ($entry in $archive.Entries) {
        $entryPath = $entry.FullName.Replace("\", "/")
        if ($entryPath -match '(^|/)(\.env($|\.)|logins\.json$|credentials?($|\.)|secrets?($|\.))' -or
            $entryPath -match '\.(pem|key|p12|pfx)$' -or
            $entryPath -match '(^|/)\.scholar-bridge(/|$)') {
          $findings += "XPI:${entryPath}: forbidden private file"
          continue
        }
        $extension = [System.IO.Path]::GetExtension($entryPath).ToLowerInvariant()
        if ($textExtensions -notcontains $extension) { continue }
        $reader = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8, $true)
        try {
          $content = $reader.ReadToEnd()
        } finally {
          $reader.Dispose()
        }
        $findings += Test-TextContent -DisplayPath "XPI:$entryPath" -Content $content
      }
    } finally {
      $archive.Dispose()
    }
  }
}

if ($findings.Count -gt 0) {
  $findings | Sort-Object -Unique | ForEach-Object { Write-Error $_ }
  throw "Security scan failed. Remove secrets or personal data before publishing."
}

Write-Output "Security scan passed: no credential patterns, personal paths, personal email addresses, or Vault runtime data found."
