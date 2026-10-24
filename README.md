# `@nexustools/nwjsreleasepackager`

Pure Node.js, cross-platform **NW.js Release Packager** implementing the official [NW.js Package and Distribute](https://docs.nwjs.io/For%20Users/Package%20and%20Distribute/) workflow with **zero external tool dependencies**.

Generates ready-to-distribute installers and archives for **Windows**, **macOS**, and **Linux** from any host operating system:

- **Windows**:
  - **`.zip` Release (`win-zip`)**: Portable application directory with renamed `<executable>.exe`, injected PE32/PE32+ `.rsrc` icons (`RT_ICON`, `RT_GROUP_ICON`) and `VS_VERSIONINFO` (`RT_VERSION`).
  - **`.msi` Installer (`win-msi`)**: Spec-compliant Windows Installer OLE2 Compound File (`.msi`) with embedded Microsoft Cabinet (`media1.cab`), `ProgramFiles64Folder` / `ProgramFilesFolder` installation, Desktop & Start Menu shortcuts, and Add/Remove Programs metadata.
- **macOS**:
  - **Mountable `.dmg` Disk Image (`mac-dmg`)**: Apple Universal Disk Image Format (`koly` trailer + `blkx` `Mish` zlib-compressed blocks) wrapping a native **HFS+ (Mac OS Extended)** filesystem containing `<ProductName>.app` (with customized `Contents/Info.plist`, `app.icns`, and `Contents/Resources/app.nw`), a Finder `.DS_Store` icon-view layout, and a `/Applications` symbolic link for drag-and-drop installation into `Applications`.
- **Linux**:
  - **Debian `.deb` Package (`linux-deb`)**: Standard UNIX `ar` archive (`debian-binary`, `control.tar.gz`, `data.tar.gz`) installing into `/opt/<app>`, `/usr/bin/<app>`, `/usr/share/applications/<app>.desktop`, and `/usr/share/icons/hicolor/256x256/apps/<app>.png`.
  - **Flatpak Single-File Bundle (`linux-flatpak`)**: Self-contained `.flatpak` GVariant + OSTree static-delta bundle with sandbox permissions, `.desktop` export, and AppStream MetaInfo XML.
  - **`.zip` Release (`linux-zip`)**: Portable archive preserving POSIX `0755` executable mode bits in the ZIP central directory alongside a `.desktop` launcher.

---

## Bundling Modes (Per NW.js Documentation)

1. **`plain` (Default & Recommended)**:
   - Places application files directly alongside `nw.exe` / `nw` on Windows and Linux, and inside `<ProductName>.app/Contents/Resources/app.nw/` on macOS.
2. **`zip`**:
   - Packs application files into a ZIP archive named `package.nw` (Windows/Linux) or `app.nw` (macOS).
3. **`fused`**:
   - Binary-concatenates the `package.nw` ZIP archive directly onto the end of `<executable>.exe` / `<executable>`.

---

## CLI Usage

```bash
# Generate a starter nwjsreleasepackager.json config file
npx nwjsreleasepackager --init

# Package for Windows (.zip, .msi), macOS (.dmg), and Linux (.deb, .flatpak, .zip)
npx nwjsreleasepackager --project ./my-nwjs-app --nw-version 0.93.0 --flavor normal --mode plain

# Build specific platforms or formats
npx nwjsreleasepackager --platforms win,osx,linux --formats win-zip,win-msi,mac-dmg,linux-deb,linux-flatpak,linux-zip
```

---

## Programmatic API

```typescript
import { NwjsReleasePackager } from '@nexustools/nwjsreleasepackager';

const packager = new NwjsReleasePackager({
  projectDir: './my-nwjs-app',
  outputDir: './release',
  appName: 'my-nwjs-app',
  productName: 'My NW.js App',
  version: '1.0.0',
  appId: 'io.nexustools.mynwjsapp',
  nwVersion: '0.93.0',
  nwFlavor: 'normal',
  bundlingMode: 'plain',
  platforms: ['win', 'osx', 'linux'],
  win: {
    arch: ['x64'],
    formats: ['win-zip', 'win-msi'],
    manufacturer: 'NexusTools'
  },
  mac: {
    arch: ['x64', 'arm64'],
    formats: ['mac-dmg']
  },
  linux: {
    arch: ['x64'],
    formats: ['linux-deb', 'linux-flatpak', 'linux-zip']
  }
});

const result = await packager.packageAll();
console.log(result.artifacts);
```

---

## Configuration in `package.json`

You can also configure packaging directly inside your NW.js project's `package.json` under the `"nwjsPackager"` key:

```json
{
  "name": "my-nwjs-app",
  "productName": "My NW.js App",
  "version": "1.0.0",
  "main": "index.html",
  "nwjsPackager": {
    "appId": "io.nexustools.mynwjsapp",
    "nwVersion": "0.93.0",
    "nwFlavor": "normal",
    "bundlingMode": "plain",
    "icon": "assets/icon.png",
    "platforms": ["win", "osx", "linux"]
  }
}
```
