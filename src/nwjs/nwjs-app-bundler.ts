import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ResolvedPackagerConfig,
  TargetArch,
  TargetPlatform
} from '../types/packager-types.js';
import { VirtualFileEntry } from '../types/binary-types.js';
import { ZipArchiveWriter } from '../codecs/zip-archive-writer.js';
import { PeResourceEditor } from '../codecs/pe-resource-editor.js';
import { IcnsCodec } from '../codecs/icns-codec.js';

/**
 * Prepares and bundles an NW.js project with platform-specific NW.js runtime binaries
 * according to the official NW.js "Package and Distribute" specification:
 * - Validates cross-platform path casing, Windows path lengths, and native addon warnings.
 * - Supports 'plain', 'zip' (`package.nw` / `app.nw`), and 'fused' (binary concatenated) modes.
 * - Customizes Windows PE resources (`nw.exe` -> `<executableName>.exe`), macOS `.app` bundle
 *   (`Info.plist`, `InfoPlist.strings`, `app.icns`), and Linux executable permissions.
 */
export class NwjsAppBundler {
  /**
   * Collects all application files from the project root while honoring exclusion patterns
   * and performing NW.js distribution sanity checks.
   */
  public static collectAppFiles(
    config: ResolvedPackagerConfig
  ): { files: VirtualFileEntry[]; warnings: string[] } {
    const warnings: string[] = [];
    const files: VirtualFileEntry[] = [];

    const pkgPath = path.join(config.projectDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      throw new Error(`NW.js project is missing package.json in ${config.projectDir}`);
    }

    const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
    const mainField = typeof pkgJson.main === 'string' ? pkgJson.main : undefined;
    if (!mainField) {
      warnings.push('package.json does not specify a "main" entry file required by NW.js.');
    } else {
      const cleanMain = mainField.replace(/^\.\//, '');
      const mainFullPath = path.join(config.projectDir, cleanMain);
      if (!fs.existsSync(mainFullPath)) {
        warnings.push(`package.json "main" target "${mainField}" was not found at ${mainFullPath}.`);
      } else {
        // Verify exact case sensitivity per NW.js Linux/macOS documentation
        const dirEntries = fs.readdirSync(path.dirname(mainFullPath));
        const expectedBase = path.basename(mainFullPath);
        if (!dirEntries.includes(expectedBase)) {
          warnings.push(
            `Case-sensitivity mismatch for "main" entry "${mainField}". Linux and macOS file systems are often case-sensitive.`
          );
        }
      }
    }

    let foundNativeModules = false;
    let maxWinPathLen = 0;

    const walk = (currentDir: string): void => {
      const items = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(currentDir, item.name);
        const relPath = path.relative(config.projectDir, fullPath).replace(/\\/g, '/');

        if (NwjsAppBundler.shouldExclude(relPath, item.name, config.excludePatterns)) {
          continue;
        }

        const lstat = fs.lstatSync(fullPath);
        if (lstat.isDirectory()) {
          walk(fullPath);
        } else if (lstat.isFile()) {
          if (item.name.endsWith('.node')) {
            foundNativeModules = true;
          }
          if (relPath.length > maxWinPathLen) {
            maxWinPathLen = relPath.length;
          }
          files.push({
            relativePath: relPath,
            data: fs.readFileSync(fullPath),
            isDirectory: false,
            isSymlink: false,
            mode: (lstat.mode & 0o111) !== 0 ? 0o100755 : 0o100644,
            mtime: lstat.mtime
          });
        }
      }
    };

    walk(config.projectDir);

    if (foundNativeModules && config.platforms.length > 1) {
      warnings.push(
        'Native C++ addon (.node) detected in project. Per NW.js docs, native modules built for one OS/architecture will not load on other target platforms without cross-compiling via nw-gyp.'
      );
    }
    if (maxWinPathLen > 200 && config.platforms.includes('win')) {
      warnings.push(
        `Deep relative file path (${maxWinPathLen} chars) detected. Keep build directory paths short on Windows to avoid MAX_PATH (260 chars) limits.`
      );
    }

    return { files, warnings };
  }

  /**
   * Resolves the application files for a specific target `(platform, arch)` by applying any matching
   * `extraFiles` specifications (copying platform-specific binaries such as `ffmpeg` or generating/overriding
   * platform configuration files such as `ffmpegconfig.js`).
   */
  public static resolvePlatformAppFiles(
    baseAppFiles: VirtualFileEntry[],
    platform: TargetPlatform,
    arch: TargetArch,
    config: ResolvedPackagerConfig,
    warnings?: string[]
  ): VirtualFileEntry[] {
    const platformExtras =
      platform === 'win'
        ? config.win.extraFiles
        : platform === 'osx'
          ? config.mac.extraFiles
          : config.linux.extraFiles;

    const allSpecs = [...(config.extraFiles ?? []), ...(platformExtras ?? [])];
    if (allSpecs.length === 0) {
      return baseAppFiles;
    }

    const nodePlatform = platform === 'win' ? 'win32' : platform === 'osx' ? 'darwin' : 'linux';
    const ext = platform === 'win' ? '.exe' : '';

    const expandVars = (template: string): string =>
      template
        .replace(/\{platform\}/g, platform)
        .replace(/\{nodePlatform\}/g, nodePlatform)
        .replace(/\{arch\}/g, arch)
        .replace(/\{ext\}/g, ext);

    const fileMap = new Map<string, VirtualFileEntry>();
    for (const f of baseAppFiles) {
      fileMap.set(f.relativePath, f);
    }

    for (const spec of allSpecs) {
      if (spec.platforms && spec.platforms.length > 0 && !spec.platforms.includes(platform)) {
        continue;
      }
      if (spec.arch && spec.arch.length > 0 && !spec.arch.includes(arch)) {
        continue;
      }

      const destRel = expandVars(spec.destination)
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');
      if (!destRel) {
        continue;
      }

      let data: Buffer;
      let mtime = new Date();
      let sourceMode = 0o100644;

      if (typeof spec.content === 'string') {
        const expandedContent = expandVars(spec.content);
        data = Buffer.from(expandedContent, 'utf8');
      } else if (spec.source) {
        const expandedSource = expandVars(spec.source);
        const fullSourcePath = path.resolve(config.projectDir, expandedSource);
        if (!fs.existsSync(fullSourcePath)) {
          if (spec.optional) {
            warnings?.push(
              `Optional extraFile source not found for ${platform}-${arch}: ${fullSourcePath}`
            );
            continue;
          }
          throw new Error(
            `Required extraFile source not found for ${platform}-${arch}: ${fullSourcePath}`
          );
        }
        const stat = fs.statSync(fullSourcePath);
        data = fs.readFileSync(fullSourcePath);
        mtime = stat.mtime;
        sourceMode = (stat.mode & 0o111) !== 0 ? 0o100755 : 0o100644;
      } else {
        continue;
      }

      const isExecutable =
        spec.executable === true ||
        (spec.executable !== false &&
          (sourceMode === 0o100755 ||
            destRel.endsWith('.exe') ||
            destRel.endsWith('.sh') ||
            destRel.startsWith('bin/') ||
            destRel.includes('/bin/')));

      fileMap.set(destRel, {
        relativePath: destRel,
        data,
        isDirectory: false,
        isSymlink: false,
        mode: isExecutable ? 0o100755 : 0o100644,
        mtime
      });
    }

    return Array.from(fileMap.values());
  }

  /**
   * Builds a zipped `package.nw` / `app.nw` Buffer from the collected application files.
   */
  public static buildNwZipBuffer(appFiles: VirtualFileEntry[]): Buffer {
    const writer = new ZipArchiveWriter();
    for (const file of appFiles) {
      writer.addEntry(file);
    }
    return writer.toBuffer(6);
  }

  /**
   * Stages a complete Windows or Linux release directory combining NW.js runtime files
   * and the bundled application (using `plain`, `zip`, or `fused` bundling mode).
   */
  public static stageWinOrLinuxRelease(options: {
    platform: 'win' | 'linux';
    arch: TargetArch;
    nwRuntimeDir: string;
    appFiles: VirtualFileEntry[];
    config: ResolvedPackagerConfig;
    warnings?: string[];
  }): VirtualFileEntry[] {
    const resolvedAppFiles = NwjsAppBundler.resolvePlatformAppFiles(
      options.appFiles,
      options.platform,
      options.arch,
      options.config,
      options.warnings
    );
    const runtimeEntries = NwjsAppBundler.readPhysicalDirectory(options.nwRuntimeDir);
    const outEntries: VirtualFileEntry[] = [];

    const origBinaryName = options.platform === 'win' ? 'nw.exe' : 'nw';
    const targetBinaryName =
      options.platform === 'win'
        ? `${options.config.executableName}.exe`
        : options.config.executableName;

    const nwZipBuf =
      options.config.bundlingMode === 'zip' || options.config.bundlingMode === 'fused'
        ? NwjsAppBundler.buildNwZipBuffer(resolvedAppFiles)
        : null;

    let customIconBuffer: Buffer | undefined;
    const iconPath =
      options.platform === 'win' ? options.config.win.icon : options.config.linux.icon;
    if (iconPath && fs.existsSync(iconPath)) {
      customIconBuffer = fs.readFileSync(iconPath);
    }

    for (const entry of runtimeEntries) {
      if (entry.relativePath === '.nwjs-ready') {
        continue;
      }

      if (entry.relativePath === origBinaryName) {
        let binData = entry.data;
        if (options.platform === 'win') {
          binData = PeResourceEditor.applyResources(binData, {
            iconBuffer: customIconBuffer,
            productName: options.config.productName,
            fileDescription: options.config.description,
            fileVersion: options.config.version,
            companyName: options.config.win.manufacturer,
            legalCopyright: options.config.win.copyright,
            originalFilename: targetBinaryName
          });
        }

        if (options.config.bundlingMode === 'fused' && nwZipBuf) {
          binData = Buffer.concat([binData, nwZipBuf]);
        }

        outEntries.push({
          ...entry,
          relativePath: targetBinaryName,
          data: binData,
          mode: 0o100755
        });
      } else {
        outEntries.push(entry);
      }
    }

    if (options.config.bundlingMode === 'plain') {
      // Place application files directly alongside nw.exe / nw per NW.js Option 1 recommendation
      for (const appFile of resolvedAppFiles) {
        outEntries.push(appFile);
      }
    } else if (options.config.bundlingMode === 'zip' && nwZipBuf) {
      // Place package.nw alongside nw.exe / nw per NW.js Option 2 recommendation
      outEntries.push({
        relativePath: 'package.nw',
        data: nwZipBuf,
        isDirectory: false,
        isSymlink: false,
        mode: 0o100644,
        mtime: new Date()
      });
    }

    return outEntries;
  }

  /**
   * Stages a complete macOS `<ProductName>.app` bundle structure inside a virtual tree,
   * customizing `Info.plist`, `InfoPlist.strings`, `app.icns`, and placing application code
   * in `Contents/Resources/app.nw`.
   */
  public static stageMacAppBundle(options: {
    arch: TargetArch;
    nwRuntimeDir: string;
    appFiles: VirtualFileEntry[];
    config: ResolvedPackagerConfig;
    warnings?: string[];
  }): { appBundleName: string; entries: VirtualFileEntry[] } {
    const resolvedAppFiles = NwjsAppBundler.resolvePlatformAppFiles(
      options.appFiles,
      'osx',
      options.arch,
      options.config,
      options.warnings
    );
    const appBundleName = `${options.config.productName}.app`;
    const runtimeEntries = NwjsAppBundler.readPhysicalDirectory(options.nwRuntimeDir);
    const outEntries: VirtualFileEntry[] = [];

    let customIconBuf: Buffer | undefined;
    if (options.config.mac.icon && fs.existsSync(options.config.mac.icon)) {
      customIconBuf = fs.readFileSync(options.config.mac.icon);
    }
    const icnsBuffer = IcnsCodec.toIcnsBuffer(customIconBuf);

    for (const entry of runtimeEntries) {
      if (entry.relativePath === '.nwjs-ready') {
        continue;
      }

      // Rewrite leading `nwjs.app/` to `<ProductName>.app/`
      let rel = entry.relativePath;
      if (rel === 'nwjs.app' || rel.startsWith('nwjs.app/')) {
        rel = appBundleName + rel.slice('nwjs.app'.length);
      } else {
        continue;
      }

      if (rel === `${appBundleName}/Contents/MacOS/nwjs`) {
        outEntries.push({
          ...entry,
          relativePath: `${appBundleName}/Contents/MacOS/${options.config.executableName}`,
          mode: 0o100755
        });
      } else if (rel === `${appBundleName}/Contents/Info.plist`) {
        const updatedPlist = NwjsAppBundler.generateMacInfoPlist(options.config);
        outEntries.push({
          ...entry,
          relativePath: rel,
          data: Buffer.from(updatedPlist, 'utf8'),
          mode: 0o100644
        });
      } else if (rel.endsWith('/InfoPlist.strings')) {
        const stringsContent = [
          `CFBundleName = "${options.config.productName}";`,
          `CFBundleDisplayName = "${options.config.productName}";`,
          `CFBundleGetInfoString = "${options.config.productName} ${options.config.version}, ${options.config.mac.copyright}";`,
          `NSHumanReadableCopyright = "${options.config.mac.copyright}";`,
          ''
        ].join('\n');
        outEntries.push({
          ...entry,
          relativePath: rel,
          data: Buffer.from(stringsContent, 'utf8'),
          mode: 0o100644
        });
      } else if (
        rel === `${appBundleName}/Contents/Resources/app.icns` ||
        rel === `${appBundleName}/Contents/Resources/document.icns`
      ) {
        outEntries.push({
          ...entry,
          relativePath: rel,
          data: icnsBuffer,
          mode: 0o100644
        });
      } else {
        outEntries.push({
          ...entry,
          relativePath: rel
        });
      }
    }

    // Ensure app.icns is always present even if runtime template didn't have one
    const appIcnsRel = `${appBundleName}/Contents/Resources/app.icns`;
    if (!outEntries.some((e) => e.relativePath === appIcnsRel)) {
      outEntries.push({
        relativePath: appIcnsRel,
        data: icnsBuffer,
        isDirectory: false,
        isSymlink: false,
        mode: 0o100644,
        mtime: new Date()
      });
    }

    // Place application files inside Contents/Resources/app.nw
    if (options.config.bundlingMode === 'zip' || options.config.bundlingMode === 'fused') {
      const nwZip = NwjsAppBundler.buildNwZipBuffer(resolvedAppFiles);
      outEntries.push({
        relativePath: `${appBundleName}/Contents/Resources/app.nw`,
        data: nwZip,
        isDirectory: false,
        isSymlink: false,
        mode: 0o100644,
        mtime: new Date()
      });
    } else {
      for (const appFile of resolvedAppFiles) {
        outEntries.push({
          ...appFile,
          relativePath: `${appBundleName}/Contents/Resources/app.nw/${appFile.relativePath}`
        });
      }
    }

    return { appBundleName, entries: outEntries };
  }

  private static generateMacInfoPlist(config: ResolvedPackagerConfig): string {
    const esc = (s: string): string =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>CFBundleDevelopmentRegion</key>',
      '  <string>en</string>',
      '  <key>CFBundleDisplayName</key>',
      `  <string>${esc(config.productName)}</string>`,
      '  <key>CFBundleExecutable</key>',
      `  <string>${esc(config.executableName)}</string>`,
      '  <key>CFBundleIconFile</key>',
      '  <string>app.icns</string>',
      '  <key>CFBundleIdentifier</key>',
      `  <string>${esc(config.mac.bundleId)}</string>`,
      '  <key>CFBundleInfoDictionaryVersion</key>',
      '  <string>6.0</string>',
      '  <key>CFBundleName</key>',
      `  <string>${esc(config.productName)}</string>`,
      '  <key>CFBundlePackageType</key>',
      '  <string>APPL</string>',
      '  <key>CFBundleShortVersionString</key>',
      `  <string>${esc(config.version)}</string>`,
      '  <key>CFBundleVersion</key>',
      `  <string>${esc(config.version)}</string>`,
      '  <key>LSApplicationCategoryType</key>',
      `  <string>${esc(config.mac.category)}</string>`,
      '  <key>LSMinimumSystemVersion</key>',
      '  <string>10.15.0</string>',
      '  <key>NSHighResolutionCapable</key>',
      '  <true/>',
      '  <key>NSHumanReadableCopyright</key>',
      `  <string>${esc(config.mac.copyright)}</string>`,
      '</dict>',
      '</plist>\n'
    ].join('\n');
  }

  private static readPhysicalDirectory(rootDir: string): VirtualFileEntry[] {
    const list: VirtualFileEntry[] = [];
    const walk = (dir: string): void => {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
        const lstat = fs.lstatSync(fullPath);

        if (lstat.isSymbolicLink()) {
          const target = fs.readlinkSync(fullPath);
          list.push({
            relativePath: relPath,
            data: Buffer.from(target, 'utf8'),
            isDirectory: false,
            isSymlink: true,
            symlinkTarget: target,
            mode: 0o120777,
            mtime: lstat.mtime
          });
        } else if (lstat.isDirectory()) {
          list.push({
            relativePath: relPath,
            data: Buffer.alloc(0),
            isDirectory: true,
            isSymlink: false,
            mode: 0o040755,
            mtime: lstat.mtime
          });
          walk(fullPath);
        } else if (lstat.isFile()) {
          const isExe =
            (lstat.mode & 0o111) !== 0 ||
            item.name === 'nw' ||
            item.name === 'nwjs' ||
            item.name === 'chrome-sandbox' ||
            item.name.endsWith('.exe') ||
            item.name.endsWith('.sh') ||
            item.name.endsWith('.so');
          list.push({
            relativePath: relPath,
            data: fs.readFileSync(fullPath),
            isDirectory: false,
            isSymlink: false,
            mode: isExe ? 0o100755 : 0o100644,
            mtime: lstat.mtime
          });
        }
      }
    };
    walk(rootDir);
    return list;
  }

  private static shouldExclude(
    relPath: string,
    baseName: string,
    patterns: string[]
  ): boolean {
    for (const pat of patterns) {
      const cleanPat = pat.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!cleanPat) continue;
      if (cleanPat.startsWith('*.')) {
        const ext = cleanPat.slice(1);
        if (baseName.endsWith(ext)) return true;
      } else if (
        relPath === cleanPat ||
        relPath.startsWith(`${cleanPat}/`) ||
        baseName === cleanPat
      ) {
        return true;
      }
    }
    return false;
  }
}
