$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$xpiPath = Join-Path $projectRoot "dist\obsidian-scholar-bridge-0.8.0.xpi"

if (-not (Test-Path -LiteralPath $xpiPath)) {
  throw "XPI not found: $xpiPath"
}

[xml](Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot "chrome\content\preferences.xhtml")) | Out-Null
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot "manifest.json") | ConvertFrom-Json
if ($manifest.version -ne "0.8.0") { throw "Unexpected manifest version" }
if (-not $manifest.applications.zotero.update_url) {
  throw "Zotero 9 requires applications.zotero.update_url"
}
if ($manifest.applications.zotero.update_url -match 'example\.invalid') {
  throw "Public release must use a real update URL"
}
if ($manifest.applications.zotero.id -notmatch '^[a-z0-9._-]+@[a-z0-9._-]+$') {
  throw "Invalid Zotero add-on ID"
}
if ([version]$manifest.applications.zotero.strict_min_version -gt [version]"9.0") {
  throw "Zotero 9.0.6 would not satisfy strict_min_version"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($xpiPath)
try {
  $rawNames = @($archive.Entries | ForEach-Object { $_.FullName })
  if ($rawNames | Where-Object { $_ -match "\\" }) {
    throw "XPI contains Windows backslashes; ZIP entry paths must use forward slashes"
  }
  $names = $rawNames
  $required = @(
    "manifest.json",
    "bootstrap.js",
    "prefs.js",
    "chrome/content/preferences.xhtml",
    "chrome/content/scripts/core.js",
    "chrome/content/scripts/preferences.js",
    "chrome/content/scripts/scholarBridge.js"
  )
  foreach ($name in $required) {
    if ($names -notcontains $name) { throw "Missing XPI entry: $name" }
  }
  foreach ($icon in @("chrome/content/icons/icon-48.svg", "chrome/content/icons/icon-96.svg")) {
    if ($names -notcontains $icon) { throw "Manifest icon is missing from XPI: $icon" }
  }
} finally {
  $archive.Dispose()
}

$mainScript = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot "chrome\content\scripts\scholarBridge.js")
$coreScript = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot "chrome\content\scripts\core.js")
if ($mainScript -notmatch "deepseek-v4-pro" -and (Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot "prefs.js")) -notmatch "deepseek-v4-pro") {
  throw "DeepSeek V4 Pro preset missing"
}
if ($mainScript -match 'Reader\.unregisterEventListener\("renderTextSelectionPopup"') {
  throw "Unsafe manual Reader listener cleanup detected for Zotero 9.0.6"
}
if ($mainScript -notmatch 'createElementNS\("http://www\.w3\.org/1999/xhtml"') {
  throw "XHTML namespace helper missing; Zotero XUL item panes cannot safely render HTML controls"
}
if ($mainScript -match 'doc\.createElement\(') {
  throw "Non-namespaced doc.createElement detected in Zotero XUL UI code"
}
foreach ($workspaceMarker in @(
  'renderToolbar',
  'focusPaperAIWorkspace',
  'obsidian-scholar-bridge-workspace-drawer',
  'position:fixed',
  'enableWorkspaceResizing',
  'enableWorkspaceDragging',
  'drawer.style.display = "none"',
  '_scholarBridgeShowTab',
  'registerToolsMenu',
  'main/menubar/tools',
  'renderChatUIWithFallback',
  'dictionaryTab',
  'chatTab',
  'role", "tablist'
)) {
  if ($mainScript -notmatch [regex]::Escape($workspaceMarker)) {
    throw "Paper AI workspace regression: missing $workspaceMarker"
  }
}
if ($mainScript -match 'ItemPaneManager\.registerSection') {
  throw "Paper AI must not register in Zotero native right-side icon stack"
}

$preferencesScript = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot "chrome\content\scripts\preferences.js")
$preferencesMarkup = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot "chrome\content\preferences.xhtml")
$bootstrapScript = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot "bootstrap.js")
if ($bootstrapScript -notmatch 'loadSubScript\([\s\S]*preferences\.js' -or
    $bootstrapScript -notmatch 'Zotero\.ObsidianScholarBridgePrefs') {
  throw "Preferences controller is not loaded into the Zotero plugin sandbox"
}
if ($preferencesMarkup -notmatch 'Zotero\.ObsidianScholarBridgePrefs\.init\(window\)') {
  throw "Preferences XHTML does not initialize the sandbox controller"
}
foreach ($menuID in @(
  "bridge-provider",
  "bridge-answer-language",
  "bridge-reading-mode",
  "bridge-paper-model-quality"
)) {
  if ($preferencesMarkup -notmatch ('<menulist\s+id="' + [regex]::Escape($menuID) + '"\s+native="true"')) {
    throw "Zotero-native preference menu missing: $menuID"
  }
}
if ($preferencesMarkup -match '<html:select') {
  throw "HTML select detected; use native XUL menulist in Zotero preferences"
}
if ($mainScript -match 'scripts:\s*\[[^\]]*preferences\.js') {
  throw "Unsupported PreferencePanes scripts property detected"
}
if ($preferencesScript -match 'picker\.init\(window\b' -or
    $preferencesScript -notmatch 'picker\.init\(this\.win\b') {
  throw "File picker must use the preferences window passed into the sandbox controller"
}
if ($preferencesScript -notmatch 'typeof picker\.file === "string"') {
  throw "File picker must support Zotero 9 string path return values"
}
foreach ($providerMarker in @(
  'value="deepseek"',
  'bridge-provider-preset',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'https://api.deepseek.com'
)) {
  if (($preferencesMarkup + $preferencesScript + $mainScript) -notmatch [regex]::Escape($providerMarker)) {
    throw "DeepSeek provider regression: missing $providerMarker"
  }
}
foreach ($featureMarker in @(
  'saveVocabulary',
  'prepareVocabulary',
  'commitVocabulary',
  'vocabularyPreviews',
  'renderDictionaryPreview',
  'buildPaperMemory',
  'PAPER_MEMORY_FILE',
  'PAPER_SESSIONS_FOLDER',
  'renderVocabularyMarkdown',
  'sense_id',
  'mode === "quick"',
  'mode === "full"',
  'paperModelQuality',
  'modelSelect',
  'requestedQuality',
  'mergeVocabularyEntries',
  'collocation_notes',
  'sentence_analysis',
  'verificationEvidence'
)) {
  if ($mainScript -notmatch [regex]::Escape($featureMarker) -and
      $coreScript -notmatch [regex]::Escape($featureMarker)) {
    throw "Core feature regression: missing $featureMarker"
  }
}
foreach ($sessionMarker in @(
  'SESSION_SCHEMA_VERSION',
  'paperSessionStatePath',
  'persistActivePaperSession',
  'resumePaperSession',
  'startNewPaperSession',
  'importPublishedSessions',
  'pdf_fingerprint',
  'textFingerprint',
  'parsePaperMemoryMetadata',
  'selectConversationHistory',
  'fitSessionFileName',
  'answerOnlyButton',
  'rebuildForModelButton'
)) {
  if ($mainScript -notmatch [regex]::Escape($sessionMarker) -and
      $coreScript -notmatch [regex]::Escape($sessionMarker)) {
    throw "Persistent session or memory fingerprint regression: missing $sessionMarker"
  }
}
foreach ($readingMarker in @(
  'ensureKaTeXStyles',
  'renderScholarMarkdown',
  'renderMath',
  'answerSizeSelect',
  'normalizeMathMarkdown',
  'enableWorkspaceResizing',
  'enableVerticalResizing',
  'showConversationContextMenu',
  'quoteConversationText',
  'copyConversationText',
  'renderToString'
)) {
  if ($mainScript -notmatch [regex]::Escape($readingMarker) -and
      $coreScript -notmatch [regex]::Escape($readingMarker)) {
    throw "Readable answer or math rendering regression: missing $readingMarker"
  }
}
foreach ($interactionMarker in @(
  '_scholarBridgeInsertQuestion',
  'dictionaryView.style.display',
  'chatView.style.display',
  'selectedRaw.length > 12000',
  'enableWorkspaceDragging',
  'WORKSPACE_THEMES',
  'applyWorkspaceTheme',
  'themeSelect'
)) {
  if ($mainScript -notmatch [regex]::Escape($interactionMarker)) {
    throw "Workspace interaction regression: missing $interactionMarker"
  }
}
if ($mainScript -match 'openWorkspacePopout' -or $mainScript -match 'popoutButton') {
  throw "Obsolete popout window code must remain removed"
}
if ($mainScript -notmatch 'NS_ERROR_FILE_NOT_FOUND' -or
    $mainScript -notmatch 'vocabularyPreviewViews\.delete' -or
    $mainScript -notmatch 'safelyUpdateTransientControl') {
  throw "OneDrive write recovery or dead preview cleanup is missing"
}
if ($mainScript -match 'maximizeButton' -or
    $mainScript -match 'quoteSelectionButton' -or
    $mainScript -match 'copySelectionButton' -or
    $mainScript -match 'answerResizeGrip') {
  throw "Removed workspace controls must not return"
}
$bootstrapScript = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot "bootstrap.js")
if ($bootstrapScript -notmatch 'vendor/katex/katex\.min\.js' -or
    $bootstrapScript -notmatch 'ScholarBridgeKatex') {
  throw "KaTeX runtime is not loaded"
}
foreach ($asset in @(
  "chrome/content/vendor/katex/katex.min.js",
  "chrome/content/vendor/katex/katex.min.css",
  "chrome/content/vendor/katex/LICENSE.txt",
  "chrome/content/vendor/katex/fonts/KaTeX_Main-Regular.woff2"
)) {
  if ($names -notcontains $asset) { throw "KaTeX package asset missing: $asset" }
}
if ($mainScript -notmatch 'Vocabulary generation is deliberately locked' -or
    $mainScript -notmatch 'const quality = "fast";') {
  throw "Vocabulary model must be locked to the configured fast model"
}
if ($mainScript -match 'const quality = existing \? "deep" : "fast"') {
  throw "Vocabulary merge must not switch to the deep model"
}
foreach ($dictionaryMarker in @(
  'typeof picker.file === "string"',
  'scholar-bridge-data-end',
  '%% scholar-bridge-occurrence:',
  'createManagedData',
  'vocabularyDataPath',
  '.scholar-bridge',
  'legacy-vocabulary',
  'headword',
  'soundmark',
  'renderOccurrenceMarkdown',
  'renderSenses'
)) {
  if (($mainScript + $coreScript + $preferencesScript) -notmatch [regex]::Escape($dictionaryMarker)) {
    throw "Dictionary rendering regression: missing $dictionaryMarker"
  }
}

$stream = [System.IO.File]::OpenRead($xpiPath)
try {
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hashValue = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace("-", "")
  } finally {
    $sha256.Dispose()
  }
} finally {
  $stream.Dispose()
}
Write-Output "Package validation passed"
Write-Output "SHA256=$hashValue"
