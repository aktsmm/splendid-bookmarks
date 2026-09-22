<#
.SYNOPSIS
  Inspect one Chrome Web Store Dashboard window through Windows UI Automation.

.DESCRIPTION
  Read-only fallback for an already-authenticated Edge or Chrome window that cannot be
  reached through Playwright/CDP. The caller must provide the browser root process ID
  and the expected item ID. The script refuses ambiguous windows and prints only the
  selected CWS URL, matching item/version labels, and publication/review statuses.

  If browser chrome is visible but RootWebArea is absent, UI Automation has not exposed
  the page yet. After verifying that the exact CWS page has no unsaved work, reload it
  once and rerun this script. Do not restart the browser, copy profiles, or borrow an
  unrelated automation session.

  For a manual UIA submission, use ValuePattern/InvokePattern rather than coordinates,
  keys, or clipboard. A native file chooser is owned only when its process is a child of
  the pinned browser and that browser window is disabled by the modal. Verify artifact
  hashes before selection. CWS may accept only the first image from a multi-file choice;
  upload screenshots individually and count them after each upload. After saving, navigate
  away and back and compare both locale descriptions with check-listing-copy.mjs. Submit
  once, then prove non-application before any retry. Completion is the Dashboard item
  showing the expected version and Pending review, not a transient toast.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory, ParameterSetName = 'Inspect')]
  [ValidateRange(1, 2147483647)]
  [int]$BrowserProcessId,

  [Parameter(Mandatory, ParameterSetName = 'Inspect')]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExpectedItemId,

  [Parameter(ParameterSetName = 'Inspect')]
  [ValidatePattern('^\d+(\.\d+){0,3}$')]
  [string]$ExpectedVersion,

  [Parameter(Mandatory, ParameterSetName = 'SelfTest')]
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if ($SelfTest) {
  $cwsPattern = '^https://chrome\.google\.com/webstore/devconsole/'
  if ('https://chrome.google.com/webstore/devconsole/publisher/item/edit' -notmatch $cwsPattern -or
      'https://example.com/webstore/devconsole/' -match $cwsPattern -or
      'ehmdjfhakpifieboiogjemfdbgaemmaj' -notmatch '^[a-p]{32}$' -or
      'ehmdjfhakpifieboiogjemfdbgaemmaz' -match '^[a-p]{32}$') {
    throw 'CWS URL or item ID guard self-test failed.'
  }
  Write-Output 'SELF-TEST PASS: exact CWS origin and Chrome extension ID guards'
  return
}

$browser = Get-Process -Id $BrowserProcessId -ErrorAction Stop
if ($browser.ProcessName -notin @('msedge', 'chrome')) {
  throw "Process $BrowserProcessId is not Edge or Chrome."
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$processCondition = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
  $BrowserProcessId
)
$windows = $root.FindAll(
  [System.Windows.Automation.TreeScope]::Children,
  $processCondition
)
$candidates = @()
foreach ($window in $windows) {
  $descendants = $window.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $address = $null
  foreach ($element in $descendants) {
    if ($element.Current.ClassName -ne 'OmniboxViewViews') { continue }
    try {
      $pattern = [System.Windows.Automation.ValuePattern]$element.GetCurrentPattern(
        [System.Windows.Automation.ValuePattern]::Pattern
      )
      $address = $pattern.Current.Value
    } catch {
      continue
    }
  }
  if ($address -match '^https://chrome\.google\.com/webstore/devconsole/') {
    $candidates += [pscustomobject]@{
      Window = $window
      Descendants = $descendants
      Address = $address
    }
  }
}

if ($candidates.Count -ne 1) {
  throw "Expected one CWS window for process $BrowserProcessId; found $($candidates.Count)."
}

$candidate = $candidates[0]
$webContentAvailable = $false
$itemMatched = $false
$labels = [System.Collections.Generic.HashSet[string]]::new()
foreach ($element in $candidate.Descendants) {
  $name = $element.Current.Name
  if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) {
    $webContentAvailable = $true
  }
  $value = $null
  try {
    $pattern = [System.Windows.Automation.ValuePattern]$element.GetCurrentPattern(
      [System.Windows.Automation.ValuePattern]::Pattern
    )
    $value = $pattern.Current.Value
  } catch {
    # Most controls do not expose ValuePattern.
  }
  if ($name -match [regex]::Escape($ExpectedItemId) -or $value -match [regex]::Escape($ExpectedItemId)) {
    $itemMatched = $true
  }
  foreach ($text in @($name, $value)) {
    if ([string]::IsNullOrWhiteSpace($text)) { continue }
    if ($text -match '(?i)(version|バージョン)\s+\d+(\.\d+){0,3}' -or
        $text -match '^(Pending review|審査待ち|Published|公開済み|公開済み - 一般公開)$' -or
        $text -match '(審査のために送信されました|submitted for review)') {
      [void]$labels.Add($text.Trim())
    }
  }
}

if (-not $webContentAvailable) {
  throw 'CWS browser chrome matched, but RootWebArea is unavailable. Verify the clean page, reload it once, and rerun.'
}
if (-not $itemMatched) {
  throw "Expected CWS item $ExpectedItemId was not found in the selected page."
}
if ($ExpectedVersion -and -not ($labels | Where-Object { $_ -match "(?i)(version|バージョン)\s+$([regex]::Escape($ExpectedVersion))" })) {
  throw "Expected version $ExpectedVersion was not found in the selected page."
}

[pscustomobject]@{
  browserProcessId = $BrowserProcessId
  windowHandle = $candidate.Window.Current.NativeWindowHandle
  pageUrl = $candidate.Address
  itemId = $ExpectedItemId
  itemMatched = $itemMatched
  webContentAvailable = $webContentAvailable
  labels = @($labels | Sort-Object)
} | ConvertTo-Json -Depth 3
