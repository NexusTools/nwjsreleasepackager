import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  ReleaseArtifact,
  ResolvedPackagerConfig
} from '../types/packager-types.js';
import { VirtualFileEntry } from '../types/binary-types.js';
import { DsStoreBuilder } from '../codecs/ds-store-builder.js';
import { HfsPlusVolumeBuilder } from '../codecs/hfs-plus-volume-builder.js';
import { UdifDmgWriter } from '../codecs/udif-dmg-writer.js';

/**
 * Packages a staged macOS `<ProductName>.app` bundle into a mountable Apple UDIF `.dmg`
 * disk image containing an HFS+ volume, `.DS_Store` icon-view layout, and an `Applications`
 * symbolic link (`/Applications`) for drag-and-drop installation.
 */
export class MacDmgBuilder {
  /**
   * Generates `<appName>-<version>-mac-<arch>.dmg` in `config.outputDir`.
   */
  public static build(options: {
    config: ResolvedPackagerConfig;
    arch: 'x64' | 'arm64';
    appBundleName: string;
    stagedAppEntries: VirtualFileEntry[];
  }): ReleaseArtifact {
    const fileName = `${options.config.appName}-${options.config.version}-mac-${options.arch}.dmg`;
    const filePath = path.join(options.config.outputDir, fileName);

    const dsStoreBuf = DsStoreBuilder.buildDmgDsStore(options.appBundleName);

    const volumeEntries: VirtualFileEntry[] = [
      ...options.stagedAppEntries,
      // Symbolic link `Applications` -> `/Applications` so users can drag `<App>.app` into Applications
      {
        relativePath: 'Applications',
        data: Buffer.from('/Applications', 'utf8'),
        isDirectory: false,
        isSymlink: true,
        symlinkTarget: '/Applications',
        mode: 0o120777,
        mtime: new Date()
      },
      // Finder `.DS_Store` positioning `<App>.app` on the left and `Applications` on the right
      {
        relativePath: '.DS_Store',
        data: dsStoreBuf,
        isDirectory: false,
        isSymlink: false,
        mode: 0o100644,
        mtime: new Date()
      }
    ];

    const hfsVolume = HfsPlusVolumeBuilder.buildVolume(
      options.config.mac.volumeName,
      volumeEntries
    );
    const dmgBuf = UdifDmgWriter.buildDmgFromHfsVolume(
      hfsVolume,
      options.config.mac.volumeName
    );

    fs.mkdirSync(options.config.outputDir, { recursive: true });
    fs.writeFileSync(filePath, dmgBuf);

    return {
      platform: 'osx',
      arch: options.arch,
      format: 'mac-dmg',
      filePath,
      fileName,
      sizeBytes: dmgBuf.length,
      sha256: crypto.createHash('sha256').update(dmgBuf).digest('hex')
    };
  }
}
