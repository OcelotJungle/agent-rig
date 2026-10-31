param(
  [Parameter(Mandatory = $true)] [string]$ProjectDir,
  [Parameter(Mandatory = $true)] [string]$TmpPath
)
$ErrorActionPreference = 'Stop'

$claudeDir    = Join-Path $ProjectDir '.claude'
$settingsPath = Join-Path $claudeDir 'settings.local.json'
New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null

# Read existing settings; invalid JSON throws and the file is left untouched.
# -Encoding UTF8: Windows PowerShell 5.1 otherwise reads BOM-less files as ANSI and mangles non-ASCII text.
$settings = [pscustomobject]@{}
if (Test-Path -LiteralPath $settingsPath) {
  $raw = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8
  if ($raw -and $raw.Trim()) { $settings = $raw | ConvertFrom-Json }
}

if (-not $settings.PSObject.Properties['env']) {
  $settings | Add-Member -NotePropertyName env -NotePropertyValue ([pscustomobject]@{})
}

$changed = $false
foreach ($name in 'TEMP', 'TMP', 'TMPDIR') {
  $p = $settings.env.PSObject.Properties[$name]
  if (-not $p) {
    $settings.env | Add-Member -NotePropertyName $name -NotePropertyValue $TmpPath
    $changed = $true
  } elseif ($p.Value -ne $TmpPath) {
    $p.Value = $TmpPath
    $changed = $true
  }
}

if ($changed) {
  $json = $settings | ConvertTo-Json -Depth 32
  [IO.File]::WriteAllText($settingsPath, $json, (New-Object System.Text.UTF8Encoding $false))
}
