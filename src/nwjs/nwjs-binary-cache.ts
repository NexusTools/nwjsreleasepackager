import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as https from 'node:https';
import { NwjsFlavor, TargetArch, TargetPlatform } from '../types/packager-types.js';
import { NwjsVersionResolver } from './nwjs-version-resolver.js';
import { ZipArchiveReader } from '../codecs/zip-archive-reader.js';
import { TarArchiveCodec } from '../codecs/tar-archive-codec.js';

/**
 * Downloads, caches, and extracts official NW.js binary distributions for Windows,
 * macOS, and Linux in pure Node.js. Also supports offline local NW.js directories/archives.
 */
export class NwjsBinaryCache {
  /**
   * Ensures the extracted NW.js binary distribution for the given target exists on disk
   * and returns the path to its root directory.
   */
  public static async ensureRuntime(options: {
    cacheDir: string;
    version: string;
    flavor: NwjsFlavor;
    platform: TargetPlatform;
    arch: TargetArch;
    downloadBaseUrl: string;
    localNwjsPaths?: Record<string, string>;
    onProgress?: (stage: string, detail: string) => void;
  }): Promise<string> {
    const targetKey = `${options.platform}-${options.arch}`;
    const localOverride =
      options.localNwjsPaths?.[targetKey] ??
      options.localNwjsPaths?.[options.platform] ??
      options.localNwjsPaths?.['*'];

    const info = NwjsVersionResolver.getArchiveInfo(
      options.version,
      options.flavor,
      options.platform,
      options.arch,
      options.downloadBaseUrl
    );

    const extractedDir = path.join(options.cacheDir, 'extracted', info.folderName);
    const markerFile = path.join(extractedDir, '.nwjs-ready');

    if (localOverride) {
      const resolvedLocal = path.resolve(localOverride);
      if (fs.existsSync(resolvedLocal)) {
        const stat = fs.statSync(resolvedLocal);
        if (stat.isDirectory()) {
          return resolvedLocal;
        }
        // Extract local archive file (.zip or .tar.gz)
        if (!fs.existsSync(markerFile)) {
          fs.rmSync(extractedDir, { recursive: true, force: true });
          if (resolvedLocal.endsWith('.tar.gz') || resolvedLocal.endsWith('.tgz')) {
            TarArchiveCodec.extractToDirectory(resolvedLocal, extractedDir, true);
          } else {
            ZipArchiveReader.extractToDirectory(resolvedLocal, extractedDir, true);
          }
          fs.writeFileSync(markerFile, new Date().toISOString(), 'utf8');
        }
        return extractedDir;
      }
    }

    if (fs.existsSync(markerFile)) {
      return extractedDir;
    }

    const archivesDir = path.join(options.cacheDir, 'archives');
    fs.mkdirSync(archivesDir, { recursive: true });
    const archivePath = path.join(archivesDir, info.archiveFileName);

    if (!fs.existsSync(archivePath)) {
      options.onProgress?.(
        'download-nwjs',
        `Downloading NW.js ${options.version} (${options.flavor}) for ${targetKey} from ${info.downloadUrl}`
      );
      const buffer = await NwjsBinaryCache.downloadBuffer(info.downloadUrl);
      fs.writeFileSync(archivePath, buffer);
    }

    options.onProgress?.(
      'extract-nwjs',
      `Extracting ${info.archiveFileName} to ${extractedDir}`
    );
    fs.rmSync(extractedDir, { recursive: true, force: true });
    if (info.isTarGz) {
      TarArchiveCodec.extractToDirectory(archivePath, extractedDir, true);
    } else {
      ZipArchiveReader.extractToDirectory(archivePath, extractedDir, true);
    }

    fs.writeFileSync(markerFile, new Date().toISOString(), 'utf8');
    return extractedDir;
  }

  /**
   * Creates a complete structural NW.js runtime template directory for testing or offline scaffolding.
   * Includes valid PE32+ (`nw.exe`), ELF (`nw`), or Mach-O (`nwjs.app`) binary headers.
   */
  public static createSyntheticNwjsRuntime(
    baseDir: string,
    platform: TargetPlatform,
    arch: TargetArch
  ): string {
    const targetDir = path.join(baseDir, `nwjs-synthetic-${platform}-${arch}`);
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });

    if (platform === 'win') {
      fs.writeFileSync(
        path.join(targetDir, 'nw.exe'),
        NwjsBinaryCache.createMinimalPeExecutable(arch === 'x64')
      );
      fs.writeFileSync(path.join(targetDir, 'nw.dll'), Buffer.from('MZ-NW-DLL-STUB', 'ascii'));
      fs.writeFileSync(path.join(targetDir, 'icudtl.dat'), Buffer.from('ICUDTL-DATA', 'ascii'));
      fs.writeFileSync(path.join(targetDir, 'resources.pak'), Buffer.from('NW-RESOURCES-PAK', 'ascii'));
      const localesDir = path.join(targetDir, 'locales');
      fs.mkdirSync(localesDir, { recursive: true });
      fs.writeFileSync(path.join(localesDir, 'en-US.pak'), Buffer.from('EN-US-LOCALE', 'ascii'));
    } else if (platform === 'linux') {
      const elfBuf = Buffer.alloc(64, 0);
      elfBuf[0] = 0x7f;
      elfBuf[1] = 0x45; // 'E'
      elfBuf[2] = 0x4c; // 'L'
      elfBuf[3] = 0x46; // 'F'
      elfBuf[4] = arch === 'x64' ? 2 : 1; // 64-bit or 32-bit
      elfBuf[5] = 1; // Little endian
      elfBuf[6] = 1; // ELF version
      fs.writeFileSync(path.join(targetDir, 'nw'), elfBuf);
      fs.writeFileSync(path.join(targetDir, 'chrome-sandbox'), elfBuf);
      fs.writeFileSync(path.join(targetDir, 'icudtl.dat'), Buffer.from('ICUDTL-DATA', 'ascii'));
      const libDir = path.join(targetDir, 'lib');
      fs.mkdirSync(libDir, { recursive: true });
      fs.writeFileSync(path.join(libDir, 'libnw.so'), elfBuf);
      const localesDir = path.join(targetDir, 'locales');
      fs.mkdirSync(localesDir, { recursive: true });
      fs.writeFileSync(path.join(localesDir, 'en-US.pak'), Buffer.from('EN-US-LOCALE', 'ascii'));
    } else if (platform === 'osx') {
      const appDir = path.join(targetDir, 'nwjs.app', 'Contents');
      const macosDir = path.join(appDir, 'MacOS');
      const resDir = path.join(appDir, 'Resources');
      const lprojDir = path.join(resDir, 'en.lproj');
      fs.mkdirSync(macosDir, { recursive: true });
      fs.mkdirSync(lprojDir, { recursive: true });

      const machoBuf = Buffer.alloc(64, 0);
      machoBuf.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
      fs.writeFileSync(path.join(macosDir, 'nwjs'), machoBuf);
      fs.writeFileSync(
        path.join(appDir, 'Info.plist'),
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
          '<plist version="1.0">',
          '<dict>',
          '  <key>CFBundleExecutable</key>',
          '  <string>nwjs</string>',
          '  <key>CFBundleIdentifier</key>',
          '  <string>io.nwjs.nwjs</string>',
          '  <key>CFBundleName</key>',
          '  <string>nwjs</string>',
          '  <key>CFBundleDisplayName</key>',
          '  <string>nwjs</string>',
          '  <key>CFBundleIconFile</key>',
          '  <string>app.icns</string>',
          '  <key>CFBundlePackageType</key>',
          '  <string>APPL</string>',
          '</dict>',
          '</plist>\n'
        ].join('\n'),
        'utf8'
      );
      fs.writeFileSync(
        path.join(lprojDir, 'InfoPlist.strings'),
        'CFBundleName = "nwjs";\nCFBundleDisplayName = "nwjs";\n',
        'utf8'
      );
    }

    return targetDir;
  }

  /**
   * Builds a minimal valid Windows PE32/PE32+ executable buffer with `.text` section and
   * space in the section table for `PeResourceEditor` to inject `.rsrc`.
   */
  public static createMinimalPeExecutable(is64Bit = true): Buffer {
    const buf = Buffer.alloc(1024, 0);
    // DOS Header ('MZ')
    buf.writeUInt16LE(0x5a4d, 0);
    buf.writeUInt32LE(0x80, 0x3c); // e_lfanew = 0x80

    // PE Signature ('PE\0\0') at 0x80
    buf.writeUInt32LE(0x00004550, 0x80);
    // COFF File Header (20 bytes at 0x84)
    buf.writeUInt16LE(is64Bit ? 0x8664 : 0x014c, 0x84); // Machine
    buf.writeUInt16LE(1, 0x86); // NumberOfSections = 1
    const optHeaderSize = is64Bit ? 240 : 224;
    buf.writeUInt16LE(optHeaderSize, 0x94); // SizeOfOptionalHeader
    buf.writeUInt16LE(0x0022, 0x96); // Characteristics (EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE)

    // Optional Header at 0x98
    const optOff = 0x98;
    buf.writeUInt16LE(is64Bit ? 0x020b : 0x010b, optOff); // Magic
    buf.writeUInt32LE(0x1000, optOff + 16); // AddressOfEntryPoint
    buf.writeUInt32LE(0x1000, optOff + 20); // BaseOfCode
    if (is64Bit) {
      buf.writeBigUInt64LE(0x0000000140000000n, optOff + 24); // ImageBase
    } else {
      buf.writeUInt32LE(0x00400000, optOff + 28); // ImageBase
    }
    buf.writeUInt32LE(0x1000, optOff + 32); // SectionAlignment
    buf.writeUInt32LE(0x0200, optOff + 36); // FileAlignment
    buf.writeUInt16LE(6, optOff + 40); // MajorOperatingSystemVersion
    buf.writeUInt16LE(6, optOff + 48); // MajorSubsystemVersion
    buf.writeUInt32LE(0x2000, optOff + 56); // SizeOfImage
    buf.writeUInt32LE(0x0200, optOff + 60); // SizeOfHeaders
    buf.writeUInt16LE(2, optOff + 68); // Subsystem = IMAGE_SUBSYSTEM_WINDOWS_GUI
    buf.writeUInt32LE(16, optOff + (is64Bit ? 108 : 92)); // NumberOfRvaAndSizes = 16

    // Section 0 (.text) header at optOff + optHeaderSize
    const sec0 = optOff + optHeaderSize;
    buf.write('.text\0\0\0', sec0, 8, 'ascii');
    buf.writeUInt32LE(16, sec0 + 8); // VirtualSize
    buf.writeUInt32LE(0x1000, sec0 + 12); // VirtualAddress
    buf.writeUInt32LE(0x0200, sec0 + 16); // SizeOfRawData
    buf.writeUInt32LE(0x0200, sec0 + 20); // PointerToRawData
    buf.writeUInt32LE(0x60000020, sec0 + 36); // Characteristics

    // Write x86/x64 `xor eax, eax; ret` at offset 0x200
    buf[0x200] = 0x31;
    buf[0x201] = 0xc0;
    buf[0x202] = 0xc3;

    return buf;
  }

  private static downloadBuffer(url: string, redirectsLeft = 5): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https:') ? https : http;
      const req = client.get(url, { timeout: 120000 }, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects downloading ${url}`));
            return;
          }
          const redirectUrl = new URL(res.headers.location, url).toString();
          res.resume();
          NwjsBinaryCache.downloadBuffer(redirectUrl, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Failed to download ${url}: HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error(`Timeout downloading ${url}`));
      });
    });
  }
}
