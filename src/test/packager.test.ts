import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as zlib from 'node:zlib';
import {
  NwjsReleasePackager,
  NwjsBinaryCache,
  ZipArchiveReader,
  TarArchiveCodec,
  IcoCodec,
  IcnsCodec
} from '../index.js';

describe('@nexustools/nwjsreleasepackager end-to-end suite', () => {
  it('packages an NW.js project into win-zip, win-msi, mac-dmg, linux-deb, linux-flatpak, and linux-zip in pure Node.js', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nwjs-packager-test-'));

    try {
      const sampleAppDir = path.join(tmpRoot, 'sample-app');
      const outputDir = path.join(tmpRoot, 'release');
      const cacheDir = path.join(tmpRoot, 'cache');
      fs.mkdirSync(sampleAppDir, { recursive: true });

      // Create sample NW.js project
      fs.writeFileSync(
        path.join(sampleAppDir, 'package.json'),
        JSON.stringify(
          {
            name: '@nexustools/demo-nw-app',
            productName: 'DemoStudio',
            version: '2.1.0',
            description: 'Cross-platform NW.js Demo Application',
            main: 'index.html',
            author: 'NexusTools',
            license: 'MIT',
            nwjsPackager: {
              appId: 'io.nexustools.demostudio',
              nwVersion: '0.93.0',
              nwFlavor: 'normal',
              bundlingMode: 'plain'
            }
          },
          null,
          2
        ),
        'utf8'
      );

      fs.writeFileSync(
        path.join(sampleAppDir, 'index.html'),
        '<!DOCTYPE html><html><head><title>DemoStudio</title></head><body><h1>Hello NW.js</h1><script src="main.js"></script></body></html>',
        'utf8'
      );
      fs.writeFileSync(
        path.join(sampleAppDir, 'main.js'),
        'console.log("DemoStudio running on NW.js");\n',
        'utf8'
      );
      const customIconPath = path.join(sampleAppDir, 'icon.png');
      fs.writeFileSync(customIconPath, IcoCodec.createDefaultPngIcon(64));

      // Create synthetic NW.js runtimes for offline deterministic testing
      const winRuntime = NwjsBinaryCache.createSyntheticNwjsRuntime(cacheDir, 'win', 'x64');
      const osxRuntime = NwjsBinaryCache.createSyntheticNwjsRuntime(cacheDir, 'osx', 'x64');
      const linuxRuntime = NwjsBinaryCache.createSyntheticNwjsRuntime(cacheDir, 'linux', 'x64');

      const packager = new NwjsReleasePackager({
        projectDir: sampleAppDir,
        outputDir,
        cacheDir,
        icon: customIconPath,
        localNwjsPaths: {
          'win-x64': winRuntime,
          'osx-x64': osxRuntime,
          'linux-x64': linuxRuntime
        },
        platforms: ['win', 'osx', 'linux'],
        win: {
          arch: ['x64'],
          formats: ['win-zip', 'win-msi']
        },
        mac: {
          arch: ['x64'],
          formats: ['mac-dmg']
        },
        linux: {
          arch: ['x64'],
          formats: ['linux-deb', 'linux-flatpak', 'linux-zip']
        }
      });

      const result = await packager.packageAll();
      assert.equal(result.artifacts.length, 6);
      assert.equal(result.warnings.length, 0);

      // 1. Verify Windows ZIP
      const winZip = result.artifacts.find((a) => a.format === 'win-zip');
      assert.ok(winZip, 'win-zip artifact should be generated');
      const winZipEntries = ZipArchiveReader.readEntries(fs.readFileSync(winZip.filePath));
      const exeEntry = winZipEntries.find((e) => e.relativePath.endsWith('/demo-nw-app.exe'));
      assert.ok(exeEntry, 'Windows ZIP should contain renamed demo-nw-app.exe');
      assert.equal(exeEntry.data.readUInt16LE(0), 0x5a4d, 'Windows EXE should have MZ header');
      assert.ok(
        winZipEntries.some((e) => e.relativePath.endsWith('/index.html')),
        'Windows ZIP should contain plain index.html'
      );

      // 2. Verify Windows MSI
      const winMsi = result.artifacts.find((a) => a.format === 'win-msi');
      assert.ok(winMsi, 'win-msi artifact should be generated');
      const msiBuf = fs.readFileSync(winMsi.filePath);
      assert.deepEqual(
        msiBuf.subarray(0, 8),
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        'MSI should start with OLE2 CFBF signature'
      );
      assert.ok(
        msiBuf.includes(Buffer.from('MSCF', 'ascii')),
        'MSI should embed MSCF Cabinet stream'
      );

      // 3. Verify macOS DMG
      const macDmg = result.artifacts.find((a) => a.format === 'mac-dmg');
      assert.ok(macDmg, 'mac-dmg artifact should be generated');
      const dmgBuf = fs.readFileSync(macDmg.filePath);
      const kolyFooter = dmgBuf.subarray(dmgBuf.length - 512);
      assert.equal(
        kolyFooter.subarray(0, 4).toString('ascii'),
        'koly',
        'DMG must end with 512-byte koly UDIF trailer'
      );
      const xmlOffset = Number(kolyFooter.readBigUInt64BE(216));
      const xmlLength = Number(kolyFooter.readBigUInt64BE(224));
      const plistStr = dmgBuf.subarray(xmlOffset, xmlOffset + xmlLength).toString('utf8');
      assert.ok(plistStr.includes('<key>blkx</key>'), 'DMG XML plist must contain blkx table');

      // Decompress first zlib chunk from DMG data fork and verify HFS+ Volume Header ('H+')
      // and presence of DemoStudio.app, /Applications symlink, and .DS_Store
      const decompressedFirstChunk = zlib.inflateSync(dmgBuf.subarray(0, xmlOffset));
      assert.equal(
        decompressedFirstChunk.subarray(1024, 1026).toString('ascii'),
        'H+',
        'DMG HFS+ partition must have H+ Volume Header at offset 1024'
      );
      assert.ok(
        decompressedFirstChunk.includes(Buffer.from('/Applications', 'utf8')),
        'DMG HFS+ volume must contain /Applications symlink target'
      );
      assert.ok(
        decompressedFirstChunk.includes(Buffer.from('Bud1', 'ascii')),
        'DMG HFS+ volume must contain .DS_Store (Bud1) icon layout'
      );
      assert.ok(
        decompressedFirstChunk.includes(Buffer.from('io.nexustools.demostudio', 'utf8')),
        'DMG HFS+ volume must contain customized Info.plist bundle identifier'
      );

      // 4. Verify Linux DEB
      const linuxDeb = result.artifacts.find((a) => a.format === 'linux-deb');
      assert.ok(linuxDeb, 'linux-deb artifact should be generated');
      const debBuf = fs.readFileSync(linuxDeb.filePath);
      assert.equal(
        debBuf.subarray(0, 8).toString('ascii'),
        '!<arch>\n',
        'DEB must start with UNIX ar signature'
      );
      assert.ok(
        debBuf.includes(Buffer.from('debian-binary', 'ascii')),
        'DEB must contain debian-binary member'
      );
      assert.ok(
        debBuf.includes(Buffer.from('control.tar.gz', 'ascii')),
        'DEB must contain control.tar.gz member'
      );
      assert.ok(
        debBuf.includes(Buffer.from('data.tar.gz', 'ascii')),
        'DEB must contain data.tar.gz member'
      );

      // 5. Verify Linux Flatpak
      const linuxFlatpak = result.artifacts.find((a) => a.format === 'linux-flatpak');
      assert.ok(linuxFlatpak, 'linux-flatpak artifact should be generated');
      const flatpakBuf = fs.readFileSync(linuxFlatpak.filePath);
      assert.equal(
        flatpakBuf.subarray(0, 8).toString('ascii'),
        'flatpak\0',
        'Flatpak bundle must start with flatpak\\0 header'
      );
      assert.ok(
        flatpakBuf.includes(Buffer.from('app/io.nexustools.demostudio/x86_64/stable', 'utf8')),
        'Flatpak bundle must contain GVariant ref entry'
      );

      // 6. Verify Linux ZIP
      const linuxZip = result.artifacts.find((a) => a.format === 'linux-zip');
      assert.ok(linuxZip, 'linux-zip artifact should be generated');
      const linuxZipEntries = ZipArchiveReader.readEntries(fs.readFileSync(linuxZip.filePath));
      const linuxExe = linuxZipEntries.find((e) => e.relativePath.endsWith('/demo-nw-app'));
      assert.ok(linuxExe, 'Linux ZIP must contain renamed executable');
      assert.equal(
        linuxExe.mode & 0o755,
        0o755,
        'Linux executable in ZIP must preserve 0755 permissions'
      );
      assert.ok(
        linuxZipEntries.some((e) => e.relativePath.endsWith('.desktop')),
        'Linux ZIP must include a .desktop entry file'
      );

      // 7. Verify 'zip' (package.nw) and 'fused' bundling modes
      const fusedPackager = new NwjsReleasePackager({
        projectDir: sampleAppDir,
        outputDir: path.join(tmpRoot, 'release-fused'),
        cacheDir,
        bundlingMode: 'fused',
        localNwjsPaths: { 'win-x64': winRuntime },
        platforms: ['win'],
        win: { arch: ['x64'], formats: ['win-zip'] }
      });
      const fusedRes = await fusedPackager.packageAll();
      const fusedZipEntries = ZipArchiveReader.readEntries(
        fs.readFileSync(fusedRes.artifacts[0].filePath)
      );
      const fusedExe = fusedZipEntries.find((e) => e.relativePath.endsWith('/demo-nw-app.exe'))!;
      assert.equal(fusedExe.data.readUInt16LE(0), 0x5a4d, 'Fused EXE starts with MZ header');
      const fusedEmbeddedEntries = ZipArchiveReader.readEntries(fusedExe.data);
      assert.ok(
        fusedEmbeddedEntries.some((e) => e.relativePath === 'package.json'),
        'Fused EXE also functions as a valid ZIP archive containing package.json at EOF'
      );

      // 8. Verify TarArchiveCodec and IcnsCodec round-trip
      const tarGz = TarArchiveCodec.encodeTarGz([
        {
          relativePath: 'folder/test.sh',
          data: Buffer.from('#!/bin/sh\necho ok\n', 'utf8'),
          isDirectory: false,
          isSymlink: false,
          mode: 0o100755,
          mtime: new Date()
        }
      ]);
      const decodedTar = TarArchiveCodec.decodeTar(tarGz);
      assert.equal(decodedTar.length, 1);
      assert.equal(decodedTar[0].relativePath, 'folder/test.sh');
      assert.equal(decodedTar[0].mode & 0o755, 0o755);

      const icns = IcnsCodec.toIcnsBuffer();
      assert.ok(IcnsCodec.isIcns(icns));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
