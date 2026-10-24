import * as path from 'node:path';
import {
  PackagerBuildResult,
  PackagerConfig,
  ReleaseArtifact,
  ResolvedPackagerConfig
} from '../types/packager-types.js';
import { PackagerConfigLoader } from '../config/packager-config-loader.js';
import { NwjsVersionResolver } from '../nwjs/nwjs-version-resolver.js';
import { NwjsBinaryCache } from '../nwjs/nwjs-binary-cache.js';
import { NwjsAppBundler } from '../nwjs/nwjs-app-bundler.js';
import { WindowsZipBuilder } from '../builders/windows-zip-builder.js';
import { WindowsMsiBuilder } from '../builders/windows-msi-builder.js';
import { MacDmgBuilder } from '../builders/mac-dmg-builder.js';
import { LinuxZipBuilder } from '../builders/linux-zip-builder.js';
import { LinuxDebBuilder } from '../builders/linux-deb-builder.js';
import { LinuxFlatpakBuilder } from '../builders/linux-flatpak-builder.js';

/**
 * Primary orchestrator for packaging an NW.js project across Windows (`.zip`, `.msi`),
 * macOS (`.dmg` with drag-to-Applications `.app`), and Linux (`.deb`, `.flatpak`, `.zip`).
 */
export class NwjsReleasePackager {
  private readonly config: ResolvedPackagerConfig;

  public constructor(options: PackagerConfig = {}, explicitConfigPath?: string) {
    this.config = PackagerConfigLoader.resolve(options, explicitConfigPath);
  }

  /**
   * Returns the resolved packager configuration.
   */
  public getResolvedConfig(): ResolvedPackagerConfig {
    return this.config;
  }

  /**
   * Executes the full packaging pipeline across all configured platforms and output formats.
   */
  public async packageAll(options?: {
    useSyntheticNwjsIfOffline?: boolean;
  }): Promise<PackagerBuildResult> {
    const startTime = Date.now();
    const resolvedVersion = await NwjsVersionResolver.resolveVersion(this.config.nwVersion);
    this.config.nwVersion = resolvedVersion;

    this.config.onProgress?.(
      'collect-files',
      `Collecting application files from ${this.config.projectDir}`
    );
    const { files: appFiles, warnings } = NwjsAppBundler.collectAppFiles(this.config);

    const artifacts: ReleaseArtifact[] = [];

    // 1. Windows Releases (.zip, .msi)
    if (this.config.platforms.includes('win')) {
      for (const arch of this.config.win.arch) {
        const runtimeDir = await this.acquireRuntime('win', arch, options?.useSyntheticNwjsIfOffline);
        this.config.onProgress?.('stage-win', `Staging Windows (${arch}) NW.js bundle`);
        const stagedEntries = NwjsAppBundler.stageWinOrLinuxRelease({
          platform: 'win',
          arch,
          nwRuntimeDir: runtimeDir,
          appFiles,
          config: this.config,
          warnings
        });

        if (this.config.win.formats.includes('win-zip')) {
          this.config.onProgress?.('build-win-zip', `Building Windows (${arch}) ZIP release`);
          artifacts.push(
            WindowsZipBuilder.build({
              config: this.config,
              arch,
              stagedEntries
            })
          );
        }

        if (this.config.win.formats.includes('win-msi')) {
          this.config.onProgress?.('build-win-msi', `Building Windows (${arch}) MSI installer`);
          artifacts.push(
            WindowsMsiBuilder.build({
              config: this.config,
              arch,
              stagedEntries
            })
          );
        }
      }
    }

    // 2. macOS Releases (.dmg with .app and /Applications symlink)
    if (this.config.platforms.includes('osx')) {
      for (const arch of this.config.mac.arch) {
        const runtimeDir = await this.acquireRuntime('osx', arch, options?.useSyntheticNwjsIfOffline);
        this.config.onProgress?.('stage-mac', `Staging macOS (${arch}) .app bundle`);
        const { appBundleName, entries: stagedAppEntries } = NwjsAppBundler.stageMacAppBundle({
          arch,
          nwRuntimeDir: runtimeDir,
          appFiles,
          config: this.config,
          warnings
        });

        if (this.config.mac.formats.includes('mac-dmg')) {
          this.config.onProgress?.('build-mac-dmg', `Building macOS (${arch}) mountable DMG`);
          artifacts.push(
            MacDmgBuilder.build({
              config: this.config,
              arch,
              appBundleName,
              stagedAppEntries
            })
          );
        }
      }
    }

    // 3. Linux Releases (.deb, .flatpak, .zip)
    if (this.config.platforms.includes('linux')) {
      for (const arch of this.config.linux.arch) {
        const runtimeDir = await this.acquireRuntime(
          'linux',
          arch,
          options?.useSyntheticNwjsIfOffline
        );
        this.config.onProgress?.('stage-linux', `Staging Linux (${arch}) NW.js bundle`);
        const stagedEntries = NwjsAppBundler.stageWinOrLinuxRelease({
          platform: 'linux',
          arch,
          nwRuntimeDir: runtimeDir,
          appFiles,
          config: this.config,
          warnings
        });

        if (this.config.linux.formats.includes('linux-deb')) {
          this.config.onProgress?.('build-linux-deb', `Building Linux (${arch}) Debian .deb package`);
          artifacts.push(
            LinuxDebBuilder.build({
              config: this.config,
              arch,
              stagedEntries
            })
          );
        }

        if (this.config.linux.formats.includes('linux-flatpak')) {
          this.config.onProgress?.(
            'build-linux-flatpak',
            `Building Linux (${arch}) Flatpak .flatpak bundle`
          );
          artifacts.push(
            LinuxFlatpakBuilder.build({
              config: this.config,
              arch,
              stagedEntries
            })
          );
        }

        if (this.config.linux.formats.includes('linux-zip')) {
          this.config.onProgress?.('build-linux-zip', `Building Linux (${arch}) ZIP release`);
          artifacts.push(
            LinuxZipBuilder.build({
              config: this.config,
              arch,
              stagedEntries
            })
          );
        }
      }
    }

    return {
      appName: this.config.appName,
      productName: this.config.productName,
      version: this.config.version,
      nwVersion: this.config.nwVersion,
      nwFlavor: this.config.nwFlavor,
      bundlingMode: this.config.bundlingMode,
      artifacts,
      warnings,
      durationMs: Date.now() - startTime
    };
  }

  private async acquireRuntime(
    platform: 'win' | 'osx' | 'linux',
    arch: 'x64' | 'ia32' | 'arm64',
    useSyntheticNwjsIfOffline?: boolean
  ): Promise<string> {
    try {
      return await NwjsBinaryCache.ensureRuntime({
        cacheDir: this.config.cacheDir,
        version: this.config.nwVersion,
        flavor: this.config.nwFlavor,
        platform,
        arch,
        downloadBaseUrl: this.config.nwDownloadUrl,
        localNwjsPaths: this.config.localNwjsPaths,
        onProgress: this.config.onProgress
      });
    } catch (err) {
      if (useSyntheticNwjsIfOffline) {
        const syntheticBase = path.join(this.config.cacheDir, 'synthetic');
        return NwjsBinaryCache.createSyntheticNwjsRuntime(syntheticBase, platform, arch);
      }
      throw err;
    }
  }
}
