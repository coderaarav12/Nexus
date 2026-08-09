#Requires -Version 5.1
<#
.SYNOPSIS
    Mounts the Nexus Samba share as a persistent network drive (default N:).

.DESCRIPTION
    Maps \\<server-ip>\nexus to a drive letter using net use with /persistent:yes,
    so the mapping survives reboots and logins.

    - If the drive letter is already mapped, the script verifies the share is
      reachable and does nothing (or reconnects when the mapping is stale).
    - Credentials come from -User/-Password, -Credential, or interactive prompts.
    - On success it prints the mapped path and writes (then deletes) a small test
      file to confirm you have write access to the share.

.NOTES
    Run this from a NORMAL (non-elevated) PowerShell so the drive shows up in your
    own File Explorer session. Mapped drives are per-user: a drive created from an
    elevated/admin shell is not visible in the non-elevated Explorer, and vice versa.

    The Nexus share is exported by the server every 5 minutes (systemd timer). New
    files uploaded to the vault may take up to ~5 minutes to appear on N:.

.PARAMETER Server
    IP address or hostname of the Nexus server (for example 192.168.1.50).
    If omitted, you will be prompted.

.PARAMETER Drive
    Drive letter to map. Defaults to N. A trailing colon is optional.

.PARAMETER User
    Samba username on the server. If omitted, you will be prompted.

.PARAMETER Password
    Samba password. If omitted, you will be prompted securely.

.PARAMETER Credential
    A PSCredential object to use instead of -User/-Password.

.EXAMPLE
    .\mount-drive.ps1 -Server 192.168.1.50 -User aarav

    Maps N: to \\192.168.1.50\nexus and prompts for the password.

.EXAMPLE
    .\mount-drive.ps1 -Server 192.168.1.50 -User aarav -Drive Z

    Maps Z: to the share instead of the default N:.
#>
[CmdletBinding()]
param(
    [string]$Server,
    [string]$Drive = 'N',
    [string]$User,
    [string]$Password,
    [System.Management.Automation.PSCredential]$Credential
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

# ---------- normalize drive letter ----------
if ($Drive -match '^[A-Za-z]:$') { $Drive = $Drive.Substring(0, 1) }
$Drive = $Drive.ToUpperInvariant()
if ($Drive -notmatch '^[A-Z]$') {
    throw "Invalid drive letter '$Drive'. Use a single letter such as N or Z."
}
$DriveRoot = "$Drive`:\"

# ---------- resolve server ----------
if ([string]::IsNullOrWhiteSpace($Server)) {
    $Server = Read-Host 'Nexus server IP address or hostname (e.g. 192.168.1.50)'
}
$Server = $Server.Trim()
if ($Server -match '^\\\\') { $Server = $Server.TrimStart('\') }
if ([string]::IsNullOrWhiteSpace($Server)) {
    throw 'No server specified. Pass -Server <ip-or-hostname>.'
}

$Unc = "\\$Server\nexus"

# ---------- resolve credentials ----------
if ($null -eq $Credential) {
    if ([string]::IsNullOrWhiteSpace($User)) {
        $User = Read-Host 'Samba username'
    }
    $User = $User.Trim()
    if ([string]::IsNullOrEmpty($Password)) {
        $sec = Read-Host "Password for $User" -AsSecureString
        $Credential = New-Object System.Management.Automation.PSCredential($User, $sec)
    }
    else {
        $sec = ConvertTo-SecureString -String $Password -AsPlainText -Force
        $Credential = New-Object System.Management.Automation.PSCredential($User, $sec)
    }
}

# ---------- handle an existing mapping ----------
$existing = Get-PSDrive -Name $Drive -ErrorAction SilentlyContinue
if ($null -ne $existing) {
    $mappedTo = if ($existing.DisplayRoot) { $existing.DisplayRoot } else { $existing.Root }
    if (Test-Path -LiteralPath $DriveRoot) {
        Write-Host "Drive $Drive is already mapped to $mappedTo and reachable."
        if ($mappedTo -notlike "*$Server*") {
            Write-Warning "Existing mapping points to $mappedTo, not $Unc. Use -Drive to pick another letter."
        }
        Write-Host "Mapped path: $DriveRoot"
        exit 0
    }
    else {
        Write-Warning "Drive $Drive is mapped to $mappedTo but the share is unreachable. Removing the stale mapping..."
        & net use "$Drive`:" /delete /y 2>$null
    }
}

# ---------- map the share ----------
$netCred = $Credential.GetNetworkCredential()
$netArgs = @($Drive + ':', $Unc, '/persistent:yes', ('/user:' + $netCred.UserName))
if (-not [string]::IsNullOrEmpty($netCred.Password)) {
    $netArgs += $netCred.Password
}

Write-Host "Mapping $Unc to drive $Drive..."
& net use $netArgs
if ($LASTEXITCODE -ne 0) {
    throw "net use failed with exit code $LASTEXITCODE. Check the server address, the Samba share, and the username/password."
}

# ---------- verify + test write ----------
if (-not (Test-Path -LiteralPath $DriveRoot)) {
    throw "Mapping succeeded but $DriveRoot is not visible. Is the server up and is Samba exporting nexus?"
}

$testFile = Join-Path $DriveRoot ("nexus-mount-test-{0}.tmp" -f ([guid]::NewGuid().ToString('N')))
try {
    Set-Content -LiteralPath $testFile -Value ("Nexus mount test {0}" -f (Get-Date -Format o)) -Encoding UTF8
    Remove-Item -LiteralPath $testFile -Force
    Write-Host "Test write OK."
}
catch {
    Write-Warning "Mapped, but the test write failed: $($_.Exception.Message)"
}

Write-Host ""
Write-Host "Success: drive $Drive is mapped to $Unc (persistent across reboots)."
Write-Host "Mapped path: $DriveRoot"
Write-Host "Note: files appear within ~5 minutes of an upload (server exports the share via a systemd timer)."
exit 0
