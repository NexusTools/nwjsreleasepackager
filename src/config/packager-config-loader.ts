import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  PackagerConfig,
  ResolvedPackagerConfig,
  TargetPlatform
} from '../types/packager-types.js';

/**
 * Loads, merges, and validates NW.js release packager configuration from
 * target project's package.json, dedicated configuration files, and CLI/API overrides.
 */
export class PackagerConfigLoader {
  private static readonly CONFIG_FILE_NAMES = [
    'nwjsreleasepackager.json',
    '.nwjspackagerrc.json',
    'nwjs-packager.json'
  ];

  /**
   * Resolves a complete configuration by merging package.json, optional config file,
   * and explicit overrides.
   */
  public static resolve(
    overrides: PackagerConfig = {},
    explicitConfigPath?: string
  ): ResolvedPackagerConfig {
    const projectDir = path.resolve(overrides.projectDir ?? process.cwd());
    const pkgJsonPath = path.join(projectDir, 'package.json');

    let pkgJson: Record<string, unknown> = {};
    if (fs.existsSync(pkgJsonPath)) {
      const raw = fs.readFileSync(pkgJsonPath, 'utf8');
      pkgJson = JSON.parse(raw) as Record<string, unknown>;
    }

    const pkgEmbeddedConfig = (
      pkgJson.nwjsPackager ??
      pkgJson.nwjsreleasepackager ??
      pkgJson.nwbuild ??
      {}
    ) as Partial<PackagerConfig>;

    let fileConfig: Partial<PackagerConfig> = {};
    if (explicitConfigPath) {
      const resolvedConfigPath = path.resolve(projectDir, explicitConfigPath);
      if (!fs.existsSync(resolvedConfigPath)) {
        throw new Error(`Configuration file not found: ${resolvedConfigPath}`);
      }
      fileConfig = JSON.parse(fs.readFileSync(resolvedConfigPath, 'utf8')) as Partial<PackagerConfig>;
    } else {
      for (const candidate of PackagerConfigLoader.CONFIG_FILE_NAMES) {
        const candidatePath = path.join(projectDir, candidate);
        if (fs.existsSync(candidatePath)) {
          fileConfig = JSON.parse(fs.readFileSync(candidatePath, 'utf8')) as Partial<PackagerConfig>;
          break;
        }
      }
    }

    const merged: PackagerConfig = {
      ...pkgEmbeddedConfig,
      ...fileConfig,
      ...overrides,
      win: {
        ...(pkgEmbeddedConfig.win ?? {}),
        ...(fileConfig.win ?? {}),
        ...(overrides.win ?? {})
      },
      mac: {
        ...(pkgEmbeddedConfig.mac ?? {}),
        ...(fileConfig.mac ?? {}),
        ...(overrides.mac ?? {})
      },
      linux: {
        ...(pkgEmbeddedConfig.linux ?? {}),
        ...(fileConfig.linux ?? {}),
        ...(overrides.linux ?? {})
      }
    };

    const rawName = typeof pkgJson.name === 'string' ? pkgJson.name : path.basename(projectDir);
    const unScopedName = rawName.replace(/^@[^/]+\//, '');
    const appName = PackagerConfigLoader.sanitizeSlug(merged.appName ?? unScopedName);
    const productName =
      merged.productName ??
      (typeof pkgJson.productName === 'string' ? pkgJson.productName : undefined) ??
      unScopedName;
    const version =
      merged.version ??
      (typeof pkgJson.version === 'string' ? pkgJson.version : undefined) ??
      '1.0.0';
    const description =
      merged.description ??
      (typeof pkgJson.description === 'string' ? pkgJson.description : undefined) ??
      `${productName} NW.js Application`;

    const author = PackagerConfigLoader.extractAuthor(merged.author ?? pkgJson.author) || productName;
    const authorSlug = PackagerConfigLoader.sanitizeSlug(author).replace(/-/g, '') || 'app';
    const appSlugClean = appName.replace(/-/g, '') || 'nwapp';
    const appId = merged.appId ?? `io.${authorSlug}.${appSlugClean}`;
    const homepage =
      merged.homepage ??
      (typeof pkgJson.homepage === 'string' ? pkgJson.homepage : undefined) ??
      'https://nwjs.io';
    const license =
      merged.license ??
      (typeof pkgJson.license === 'string' ? pkgJson.license : undefined) ??
      'MIT';
    const executableName = merged.executableName ?? appName;

    const outputDir = path.resolve(projectDir, merged.outputDir ?? 'release');
    const cacheDir = path.resolve(projectDir, merged.cacheDir ?? '.nwjs-cache');

    const defaultExcludes = [
      '.git',
      '.github',
      '.vscode',
      '.idea',
      '.nwjs-cache',
      'release',
      'node_modules/.cache',
      '*.log',
      'nwjsreleasepackager.json',
      '.nwjspackagerrc.json'
    ];
    const excludePatterns = Array.from(
      new Set([...defaultExcludes, ...(merged.excludePatterns ?? [])])
    );

    const platforms: TargetPlatform[] = merged.platforms ?? ['win', 'osx', 'linux'];
    const copyright =
      merged.win?.copyright ??
      merged.mac?.copyright ??
      `Copyright (c) ${new Date().getFullYear()} ${author}`;

    const upgradeCode =
      merged.win?.upgradeCode ?? PackagerConfigLoader.deterministicGuid(`msi-upgrade:${appId}`);

    return {
      projectDir,
      outputDir,
      cacheDir,
      localNwjsPaths: merged.localNwjsPaths ?? {},
      appName,
      productName,
      version,
      description,
      appId,
      author,
      homepage,
      license,
      executableName,
      nwVersion: (merged.nwVersion ?? '0.93.0').replace(/^v/, ''),
      nwFlavor: merged.nwFlavor ?? 'normal',
      nwDownloadUrl: (merged.nwDownloadUrl ?? 'https://dl.nwjs.io').replace(/\/+$/, ''),
      bundlingMode: merged.bundlingMode ?? 'plain',
      excludePatterns,
      icon: merged.icon ? path.resolve(projectDir, merged.icon) : undefined,
      platforms,
      win: {
        arch: merged.win?.arch ?? ['x64'],
        formats: merged.win?.formats ?? ['win-zip', 'win-msi'],
        icon: merged.win?.icon
          ? path.resolve(projectDir, merged.win.icon)
          : merged.icon
            ? path.resolve(projectDir, merged.icon)
            : undefined,
        manufacturer: merged.win?.manufacturer ?? author,
        upgradeCode,
        createDesktopShortcut: merged.win?.createDesktopShortcut ?? true,
        createStartMenuShortcut: merged.win?.createStartMenuShortcut ?? true,
        copyright
      },
      mac: {
        arch: merged.mac?.arch ?? ['x64'],
        formats: merged.mac?.formats ?? ['mac-dmg'],
        icon: merged.mac?.icon
          ? path.resolve(projectDir, merged.mac.icon)
          : merged.icon
            ? path.resolve(projectDir, merged.icon)
            : undefined,
        bundleId: merged.mac?.bundleId ?? appId,
        category: merged.mac?.category ?? 'public.app-category.utilities',
        volumeName: merged.mac?.volumeName ?? `${productName} ${version}`,
        copyright
      },
      linux: {
        arch: merged.linux?.arch ?? ['x64'],
        formats: merged.linux?.formats ?? ['linux-deb', 'linux-flatpak', 'linux-zip'],
        icon: merged.linux?.icon
          ? path.resolve(projectDir, merged.linux.icon)
          : merged.icon
            ? path.resolve(projectDir, merged.icon)
            : undefined,
        maintainer: merged.linux?.maintainer ?? `${author} <support@${authorSlug}.io>`,
        section: merged.linux?.section ?? 'utils',
        depends: merged.linux?.depends ?? [
          'libnss3',
          'libatk1.0-0',
          'libatk-bridge2.0-0',
          'libcups2',
          'libdrm2',
          'libgtk-3-0',
          'libgbm1',
          'libasound2'
        ],
        categories: merged.linux?.categories ?? ['Utility', 'Application'],
        flatpakRuntime: merged.linux?.flatpakRuntime ?? 'org.freedesktop.Platform',
        flatpakRuntimeVersion: merged.linux?.flatpakRuntimeVersion ?? '23.08',
        flatpakSdk: merged.linux?.flatpakSdk ?? 'org.freedesktop.Sdk',
        flatpakPermissions: {
          shared: merged.linux?.flatpakPermissions?.shared ?? ['network', 'ipc'],
          sockets: merged.linux?.flatpakPermissions?.sockets ?? ['x11', 'wayland', 'pulseaudio'],
          devices: merged.linux?.flatpakPermissions?.devices ?? ['dri'],
          filesystems: merged.linux?.flatpakPermissions?.filesystems ?? ['host']
        }
      },
      onProgress: merged.onProgress
    };
  }

  /**
   * Generates a deterministic uppercase GUID string `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`
   * from any seed string using SHA-256.
   */
  public static deterministicGuid(seed: string): string {
    const hash = crypto.createHash('sha256').update(seed, 'utf8').digest();
    hash[6] = (hash[6] & 0x0f) | 0x50;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const hex = hash.subarray(0, 16).toString('hex').toUpperCase();
    return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}}`;
  }

  /**
   * Sanitizes a string into a lowercase kebab-case slug safe for filenames and Debian package names.
   */
  public static sanitizeSlug(input: string): string {
    return input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'nwjs-app';
  }

  private static extractAuthor(rawAuthor: unknown): string {
    if (typeof rawAuthor === 'string') {
      return rawAuthor.replace(/<[^>]*>/g, '').replace(/\([^)]*\)/g, '').trim();
    }
    if (rawAuthor && typeof rawAuthor === 'object' && 'name' in rawAuthor) {
      const nameVal = (rawAuthor as { name?: unknown }).name;
      if (typeof nameVal === 'string') {
        return nameVal.trim();
      }
    }
    return '';
  }
}
