# Installr

Installr is a Windows desktop app for installing and updating software through WinGet. Its catalog includes 245 apps, with installed versions, available updates, and a queue you can review before it runs.

The interface follows Windows light, dark, and contrast settings. While a batch runs, its progress also appears on the Windows taskbar.

## Install or update Installr

1. Get `Installr-Setup-<version>.exe` from [GitHub Releases](https://github.com/Lenalein2001/Installr/releases) and open it.
2. Leave **Only for me** selected for a personal install, or choose **Anyone who uses this computer (all users)**. Click **Install**. If you chose all users, approve the Windows prompt.
3. Open **Installr** from the Start menu or desktop.

Installr runs on 64-bit Windows 10 and 11. If WinGet needs attention, Installr offers a link to App Installer and an alias repair option. Release notes include the installer's SHA-256 checksum. Preview builds are unsigned, so Windows may identify the publisher as unknown.

To upgrade, run the newer setup and keep the selected installation scope. Each Windows account keeps its own Installr settings and history.

## Install or update apps

1. Search for apps or choose **Select updates**.
2. Choose **Review and install**, check the selection, then choose **Run batch**.
3. Approve any Windows prompt for an installer you want to run. Use **Settings** if you need to change language, scope, architecture, or installer mode.

Use **Skip current** to stop the active installer or **Cancel remaining** to stop after it. If Windows requests a restart, Installr saves the results and pauses the batch. Reopen Installr after restarting and choose **Review remaining apps**.

## Software sources

Installr's catalog uses the WinGet Community Repository and Microsoft Store. To find an app outside this catalog, use `winget search "app name"` or search the Microsoft Store. If a publisher distributes its app directly, use its official download page or Releases page to get an EXE, MSI, MSIX, or portable build. Windows App Installer can open MSIX packages. To save an installer from WinGet for later, use [`winget download`](https://learn.microsoft.com/en-us/windows/package-manager/winget/download).

### Publish a WinGet package

1. Host a Windows installer at a public, version-specific HTTPS URL reachable from the publisher's website. Test its unattended installation and uninstall.
2. Install [WinGet Create](https://github.com/microsoft/winget-create), then run `wingetcreate new` to generate YAML manifests with the package ID, version, installer URL, architecture, and SHA-256. Check the manifests with `winget validate --manifest <path>`.
3. Submit a pull request to [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs). The package becomes searchable through WinGet after validation, approval, and catalog publication. Submit a manifest update for each release. [Microsoft's submission guide](https://learn.microsoft.com/en-us/windows/package-manager/package/repository)

## Develop and build

Use Windows and Node.js 22.12 or newer.

```powershell
npm ci
npm run dev:desktop
npm test
npm run lint
npm run build:desktop
```

The setup is written to `release/Installr-Setup-<version>.exe`. `build-installr.bat` installs dependencies, runs the checks, and builds the same setup. Set `INSTALLR_RELEASE_DIR` to build to a different output directory.

For a portable executable, run `npm run build:desktop:portable`. For an unpacked build, run `npm run build:desktop:folder` and extract `release/public/Installr-win32-x64.zip` before running `Installr.exe` inside it.

Run `npm run benchmark:inventory` to measure fresh and cached WinGet inventory reads.
