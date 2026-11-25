# Read-only: prints the visible console text of a process as base64 of its UTF-8 bytes (see console-text.cs), so the
# console's code page and this host's output encoding cannot change the text. Exits 1 with the error on stderr when the
# console cannot be read.
param([string]$Source, [int]$Target)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -Path $Source
  $text = [Con]::Read([uint32]$Target)
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)))
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
