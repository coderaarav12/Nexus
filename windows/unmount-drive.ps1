#Requires -Version 5.1
<#
.SYNOPSIS
    Removes the Nexus network drive mapping (default N:).

.DESCRIPTION
    Deletes the net use mapping for the given drive letter. Does nothing and
    exits 0 if the drive is not mapped, so it is safe to run repeatedly.

.PARAMETER Drive
    Drive letter to remove. Defaults to N. A trailing colon is optional.

.EXAMPLE
    .\unmount-drive.ps1

    Removes N: if it is mapped.

.EXAMPLE
    .\unmount-drive.ps1 -Drive Z

    Removes Z: instead of the default N:.
#>
[CmdletBinding()]
param(
    [string]$Drive = 'N'
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

# ---------- normalize drive letter ----------
if ($Drive -match '^[A-Za-z]:$') { $Drive = $Drive.Substring(0, 1) }
$Drive = $Drive.ToUpperInvariant()
if ($Drive -notmatch '^[A-Z]$') {
    throw "Invalid drive letter '$Drive'. Use a single letter such as N or Z."
}

# ---------- nothing to do if not mapped ----------
$existing = Get-PSDrive -Name $Drive -ErrorAction SilentlyContinue
if ($null -eq $existing) {
    Write-Host "Drive $Drive is not mapped; nothing to do."
    exit 0
}

# ---------- remove the mapping ----------
Write-Host "Removing mapping $Drive... (may be mapped to $($existing.DisplayRoot))"
& net use "$Drive`:" /delete /y
if ($LASTEXITCODE -eq 0) {
    Write-Host "Removed mapping $Drive."
    exit 0
}

# net use failed (e.g. files open on the drive) - try Remove-PSDrive as a fallback
try {
    Remove-PSDrive -Name $Drive -Force -ErrorAction Stop
    Write-Host "Removed mapping $Drive."
    exit 0
}
catch {
    throw "Could not remove mapping $Drive. Close any Explorer windows or programs using the drive and try again. ($($_.Exception.Message))"
}
