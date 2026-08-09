# Windows: Mounting the Nexus drive

The Nexus server exports its file vault over Samba (native Windows SMB). Your PC maps
that share as a regular network drive, no extra software required. WinFsp/FUSE based
live mounts are explicitly deferred to Phase 2.

## Prerequisites

- **Windows 10 or Windows 11** (this guide targets Windows PowerShell 5.1, which ships
  with both).
- **SMBv1 disabled** is fine and expected. The server uses SMBv2/v3, so the old and
  insecure SMBv1 protocol must stay disabled. If a previous setup enabled SMBv1, remove
  it (Settings > Apps > Optional features, or as an admin: `Disable-WindowsOptionalFeature
  -Online -FeatureName SMB1Protocol`), then restart.
- The Nexus server is **powered on** and reachable on your LAN. The Samba share is named
  `nexus` on the server, and the Windows share path is `\\<server-ip>\nexus`.
- A **Samba account** on the server. If you created the share with the optional
  `deploy/setup-samba.sh` script, use the username/password it configured (see
  `docs/SPEC.md` and the root `README.md`).
- The **first time** you connect you will be asked for these Samba credentials. Check
  "Remember my credentials" so you are not prompted on every login.

## Step 1: Find the server's IP

On the server:

```bash
hostname -I
```

Use that address (e.g. `192.168.1.50`) anywhere this guide says `<server-ip>`. Set a
static IP / DHCP reservation on your router so the address never changes.

## Step 2: Map the drive

### Option A: PowerShell script (recommended)

Open a **normal (non-elevated)** PowerShell window. Run the mount script from this
folder:

```powershell
cd windows
.\mount-drive.ps1 -Server 192.168.1.50 -User aarav
```

You will be prompted for the Samba password. The script:

- Maps `\\192.168.1.50\nexus` to drive `N:` with `net use ... /persistent:yes`, so the
  mapping survives reboots.
- Handles the case where `N:` is already mapped (verifies it is reachable, or removes a
  stale mapping and reconnects).
- On success prints the mapped path and writes a small test file to confirm write access.

Use `-Drive Z` to pick a different letter, or pass `-Credential (Get-Credential)` if you
prefer to supply credentials that way. See the script header for all parameters.

> Do not run this from an elevated (admin) PowerShell. Persistent mappings are per-user:
> a drive created in an elevated shell will not appear in your normal Explorer, and vice
> versa.

To remove the mapping later:

```powershell
.\unmount-drive.ps1
```

### Option B: File Explorer (no script)

1. Open File Explorer and select **This PC**.
2. On the **Computer** ribbon, choose **Map network drive**.
3. Pick drive letter **N:**, and for the folder enter `\\<server-ip>\nexus`.
4. Check **Reconnect at sign-in** and click **Finish**.
5. At the credential prompt, enter your Samba username and password. Check **Remember my
   credentials**, then **OK**.
6. `N:` now opens the Nexus vault.

### Option C: net use directly (for a one-off)

```powershell
net use N: \\<server-ip>\nexus /user:aarav /persistent:yes
```

`net use` prompts for the password interactively if you omit it.

## First-time credential prompt

The first time a drive letter connects to the share, Windows shows the Samba credential
prompt. Enter the Samba username and password the server admin configured (not the
Nexus web login). Tick "Remember my credentials" to avoid being asked again. If you
moved machines, changed the server, or see "Access denied", clear the stored credential
in Credential Manager (Control Panel > Credential Manager > Windows Credentials) and map
again.

## Important: the 5-minute sync timer

The server **does not** expose the vault as a live/FUSE mount. Instead, a systemd timer
on the server exports the current vault to the Samba share roughly every **5 minutes**.
Practically this means:

- A file uploaded through the web dashboard, the backup app, or another client appears
  on `N:` **within about 5 minutes** of the upload, not instantly.
- Files you drop on `N:` are written into the exported share and picked up on the next
  export cycle.
- If a file "isn't there yet", wait for the next timer tick and refresh (`F5`) Explorer
  before assuming something is wrong.

## Refreshing the mapping

If `N:` becomes stale (server was off, network hiccup, PC slept):

```powershell
.\mount-drive.ps1 -Server 192.168.1.50 -User aarav
```

The script detects the unreachable mapping, deletes it, and remaps. Alternatively
`net use N: /delete /y` then map again.

## Troubleshooting (Windows side)

| Symptom | Likely cause / fix |
| --- | --- |
| "Network path not found" | Server off, wrong IP, or wrong share name. Confirm `hostname -I` on the server and that Samba exports `nexus`. |
| "Access denied" | Wrong Samba user/password. Clear Windows Credentials and map again; verify the account on the server. |
| Drive maps but Explorer won't open it | SMBv1-only share or old SMB config; the server uses SMBv2/3, keep SMBv1 disabled. |
| Files missing on N: | The 5-minute export timer has not ticked yet; wait and press F5. |
| `.\mount-drive.ps1` blocked by execution policy | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` in an admin shell, or run `powershell -ExecutionPolicy Bypass -File .\mount-drive.ps1 ...`. |

The full setup for the server and the share lives in the root `README.md`.
