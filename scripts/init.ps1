<#
.SYNOPSIS
  Creates .env from .env.example with strong random secrets (never overwrites existing secrets).
.EXAMPLE
  .\scripts\init.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'

function New-Secret {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $root '.env.example') $envFile
    Write-Host 'Created .env from .env.example'
}

$lines = [System.Collections.Generic.List[string]](Get-Content $envFile -Encoding UTF8)
foreach ($name in 'HTTP_BEARER_TOKEN', 'WORKER_TOKEN') {
    $index = $lines.FindIndex({ param($l) $l -match "^$name=" })
    # A secret is kept only if it looks strong: 32+ characters and not a published default.
    $current = if ($index -ge 0) { ($lines[$index] -replace "^$name=", '').Trim('"').Split(',')[0] } else { '' }
    if ($current.Length -ge 32 -and $current -ne 'mysecrettoken') {
        Write-Host "$name already set - kept"
        continue
    }
    $entry = "$name=$(New-Secret)"
    if ($index -ge 0) { $lines[$index] = $entry } else { $lines.Add($entry) }
    Write-Host "Generated $name"
}
# UTF-8 without BOM and LF line endings, so Docker Compose and Linux tools read it correctly.
[System.IO.File]::WriteAllText($envFile, (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding $false))

# Restrict the file to the current user.
$acl = Get-Acl $envFile
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule([System.Security.Principal.WindowsIdentity]::GetCurrent().Name, 'FullControl', 'Allow')
$acl.SetAccessRule($rule)
Set-Acl $envFile $acl

if ($lines | Where-Object { $_ -match '^(PROCESSING_VERBOSE|AUDIOS_DIR|ENABLE_PROCESS_LOCK_MECHANISM)=' }) {
    Write-Host 'Note: .env still contains v1 settings - see docs/migration-v1-to-v2.md'
}

$key = (($lines | Where-Object { $_ -match '^HTTP_BEARER_TOKEN=' }) -replace '^HTTP_BEARER_TOKEN=', '').Trim('"').Split(',')[0]
Write-Host ''
Write-Host "Your API key (send it as 'Authorization: Bearer <key>'):"
Write-Host $key
Write-Host ''
Write-Host 'Next: docker compose up -d --build   (no NVIDIA GPU: add -f compose.yaml -f compose.cpu.yaml)'
