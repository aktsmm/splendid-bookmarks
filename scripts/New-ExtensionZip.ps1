<#
.SYNOPSIS
  Build the Chrome Web Store upload package from extension/.

.DESCRIPTION
  Runs the repository gates first and only writes a zip when they pass, so the
  archive that reaches the store is one the checks already agreed with. Also
  emits a contents listing and a SHA256, which is what lets a release be resumed
  after an upload fails halfway.

.PARAMETER DryRun
  Run the gates and print what would be packaged, without writing anything.

.PARAMETER Force
  Overwrite an existing zip for the same version.
#>
param(
  [switch]$DryRun,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$extensionDir = Join-Path $repoRoot 'extension'
$buildDir = Join-Path $repoRoot 'builds'

Push-Location $repoRoot
try {
  # The manifest is what the store reads; package.json is what the repo reads.
  # A release where they disagree is a release nobody can identify later.
  $pkgVersion = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
  $manifestVersion = (Get-Content -LiteralPath (Join-Path $extensionDir 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
  if ($pkgVersion -ne $manifestVersion) {
    throw "version mismatch: package.json $pkgVersion, manifest.json $manifestVersion"
  }

  foreach ($gate in @('test', 'check:store')) {
    Write-Host "gate: npm run $gate"
    & npm run $gate --silent | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "gate failed: npm run $gate (exit $LASTEXITCODE). No zip was written."
    }
  }

  $files = Get-ChildItem -LiteralPath $extensionDir -Recurse -File |
    Sort-Object FullName
  $relative = $files | ForEach-Object {
    $_.FullName.Substring($extensionDir.Length + 1).Replace('\', '/')
  }
  Write-Host "`n$($relative.Count) file(s) under extension/:"
  $relative | ForEach-Object { Write-Host "  $_" }

  if ($DryRun) {
    Write-Host "`nDry run: gates passed, nothing written."
    return
  }

  New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
  $stem = Join-Path $buildDir "splendid-bookmarks-v$pkgVersion"
  $zipPath = "$stem.zip"

  if ((Test-Path -LiteralPath $zipPath) -and -not $Force) {
    throw "$zipPath already exists. Bump the version, or pass -Force to overwrite."
  }

  # extension\* keeps manifest.json at the archive root, which is where the
  # store looks for it.
  Compress-Archive -Path (Join-Path $extensionDir '*') -DestinationPath $zipPath -Force

  $relative | Set-Content -LiteralPath "$stem.contents.txt" -Encoding UTF8
  $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
  "$hash  $(Split-Path -Leaf $zipPath)" |
    Set-Content -LiteralPath "$stem.sha256" -Encoding UTF8

  $packed = @(
    [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  )
  try {
    $entries = $packed[0].Entries | Where-Object { $_.Name } | Measure-Object
    if ($entries.Count -ne $relative.Count) {
      throw "archive holds $($entries.Count) file(s), expected $($relative.Count)"
    }
  } finally {
    $packed[0].Dispose()
  }

  Write-Host "`nwrote $zipPath"
  Write-Host "     $([math]::Round((Get-Item -LiteralPath $zipPath).Length / 1KB, 1)) KB, $($relative.Count) files"
  Write-Host "     SHA256 $hash"
} finally {
  Pop-Location
}
