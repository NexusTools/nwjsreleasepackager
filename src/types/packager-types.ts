/**
 * Target operating system platforms supported by NW.js Release Packager.
 */
export type TargetPlatform = 'win' | 'linux' | 'osx';

/**
 * Target CPU architectures supported by NW.js.
 */
export type TargetArch = 'x64' | 'ia32' | 'arm64';

/**
 * NW.js build flavors ('normal' for production, 'sdk' for DevTools/nwjc).
 */
export type NwjsFlavor = 'normal' | 'sdk';

/**
 * Application bundling strategy per NW.js "Package and Distribute" docs:
 * - 'plain': Places app files directly alongside nw.exe/nw (or in package.nw/) and in Contents/Resources/app.nw/ on macOS.
 * - 'zip': Packs app files into a ZIP archive named package.nw (Windows/Linux) or app.nw (macOS).
 * - 'fused': Appends the zipped package.nw directly onto the nw.exe / nw binary executable.
 */
export type BundlingMode = 'plain' | 'zip' | 'fused';

/**
 * Supported release output package formats across platforms.
 */
export type PackageFormat =
  | 'win-zip'
  | 'win-msi'
  | 'mac-dmg'
  | 'linux-deb'
  | 'linux-flatpak'
  | 'linux-zip';

/**
 * Specification for an additional or platform-specific file to inject into the packaged application.
 * Supports copying a physical file (`source`) or generating file contents (`content`) per target
 * platform and architecture, with template variable expansion:
 * - `{platform}`: 'win' | 'osx' | 'linux'
 * - `{nodePlatform}`: 'win32' | 'darwin' | 'linux'
 * - `{arch}`: 'x64' | 'ia32' | 'arm64'
 * - `{ext}`: '.exe' on win, '' on osx/linux
 */
export interface ExtraFileSpec {
  /** Source file path on disk (relative to projectDir or absolute). Supports `{platform}`, `{nodePlatform}`, `{arch}`, `{ext}`. */
  source?: string;
  /** Inline string content to write directly to `destination` (e.g., generated config like `ffmpegconfig.js`). Supports placeholders. */
  content?: string;
  /** Destination path relative to the packaged application root (e.g., `bin/ffmpeg{ext}` or `src/ffmpegconfig.js`). Supports placeholders. */
  destination: string;
  /** Optional filter: only include this file when building for these target platforms. */
  platforms?: TargetPlatform[];
  /** Optional filter: only include this file when building for these target architectures. */
  arch?: TargetArch[];
  /** Whether the file should be marked executable (`0o100755`) in the package. */
  executable?: boolean;
  /** If true, missing `source` file records a warning instead of throwing an error. */
  optional?: boolean;
}

/**
 * Windows-specific configuration options.
 */
export interface WindowsTargetConfig {
  /** Architectures to build for Windows (default: ['x64']) */
  arch?: ('x64' | 'ia32')[];
  /** Formats to produce for Windows (default: ['win-zip', 'win-msi']) */
  formats?: ('win-zip' | 'win-msi')[];
  /** Path to .ico or .png icon file */
  icon?: string;
  /** Company / Manufacturer name for PE version info and MSI installer */
  manufacturer?: string;
  /** Windows Installer UpgradeCode GUID (deterministic UUID generated from appId if omitted) */
  upgradeCode?: string;
  /** Create a Desktop shortcut during MSI installation (default: true) */
  createDesktopShortcut?: boolean;
  /** Create a Start Menu shortcut during MSI installation (default: true) */
  createStartMenuShortcut?: boolean;
  /** Legal copyright string embedded in PE resource and MSI */
  copyright?: string;
  /** Additional or generated files specific to Windows builds */
  extraFiles?: ExtraFileSpec[];
}

/**
 * macOS-specific configuration options.
 */
export interface MacTargetConfig {
  /** Architectures to build for macOS (default: ['x64', 'arm64']) */
  arch?: ('x64' | 'arm64')[];
  /** Formats to produce for macOS (default: ['mac-dmg']) */
  formats?: 'mac-dmg'[];
  /** Path to .icns or .png icon file */
  icon?: string;
  /** macOS CFBundleIdentifier (e.g. 'com.example.myapp') */
  bundleId?: string;
  /** macOS LSApplicationCategoryType (default: 'public.app-category.utilities') */
  category?: string;
  /** Custom volume name for the mounted .dmg image */
  volumeName?: string;
  /** Copyright string for Info.plist NSHumanReadableCopyright */
  copyright?: string;
  /** Additional or generated files specific to macOS builds */
  extraFiles?: ExtraFileSpec[];
}

/**
 * Linux-specific configuration options.
 */
export interface LinuxTargetConfig {
  /** Architectures to build for Linux (default: ['x64']) */
  arch?: ('x64' | 'ia32')[];
  /** Formats to produce for Linux (default: ['linux-deb', 'linux-flatpak', 'linux-zip']) */
  formats?: ('linux-deb' | 'linux-flatpak' | 'linux-zip')[];
  /** Path to .png icon file */
  icon?: string;
  /** Debian package maintainer (e.g. 'Name <email@example.com>') */
  maintainer?: string;
  /** Debian package section (default: 'utils') */
  section?: string;
  /** Debian package dependencies */
  depends?: string[];
  /** Freedesktop .desktop categories (default: ['Utility', 'Application']) */
  categories?: string[];
  /** Flatpak runtime ID (default: 'org.freedesktop.Platform') */
  flatpakRuntime?: string;
  /** Flatpak runtime version (default: '23.08') */
  flatpakRuntimeVersion?: string;
  /** Flatpak SDK ID (default: 'org.freedesktop.Sdk') */
  flatpakSdk?: string;
  /** Flatpak finish-args / sandbox permissions */
  flatpakPermissions?: {
    shared?: string[];
    sockets?: string[];
    devices?: string[];
    filesystems?: string[];
  };
  /** Additional or generated files specific to Linux builds */
  extraFiles?: ExtraFileSpec[];
}

/**
 * Top-level configuration for NW.js Release Packager.
 */
export interface PackagerConfig {
  /** Path to the NW.js project root directory (default: process.cwd()) */
  projectDir?: string;
  /** Output directory for generated release artifacts (default: '<projectDir>/release') */
  outputDir?: string;
  /** Directory to cache downloaded NW.js binaries (default: '<projectDir>/.nwjs-cache') */
  cacheDir?: string;
  /** Optional local directory or archive map for offline NW.js binaries keyed by '<platform>-<arch>' or path */
  localNwjsPaths?: Record<string, string>;
  /** Application internal name / slug (defaults to package.json name) */
  appName?: string;
  /** Human-readable product display name (defaults to package.json productName or appName) */
  productName?: string;
  /** Application version (defaults to package.json version) */
  version?: string;
  /** Application description (defaults to package.json description) */
  description?: string;
  /** Reverse-DNS application ID (e.g., 'io.nexustools.myapp') */
  appId?: string;
  /** Author / Publisher name */
  author?: string;
  /** Homepage URL */
  homepage?: string;
  /** License identifier (default: 'MIT') */
  license?: string;
  /** Executable binary base name without extension (defaults to sanitized appName) */
  executableName?: string;
  /** NW.js version to package with (e.g., '0.93.0', 'latest', 'lts'; default: '0.93.0') */
  nwVersion?: string;
  /** NW.js build flavor: 'normal' (recommended for production) or 'sdk' (default: 'normal') */
  nwFlavor?: NwjsFlavor;
  /** Download base URL for NW.js binaries (default: 'https://dl.nwjs.io') */
  nwDownloadUrl?: string;
  /** Application bundling mode: 'plain' | 'zip' | 'fused' (default: 'plain') */
  bundlingMode?: BundlingMode;
  /** Glob/prefix patterns of project files to exclude from packaging */
  excludePatterns?: string[];
  /** Additional or generated files to inject into packaged releases across platforms/architectures */
  extraFiles?: ExtraFileSpec[];
  /** Default icon path (.png or .ico) used if platform-specific icon is not set */
  icon?: string;
  /** Target platforms to build (default: ['win', 'osx', 'linux']) */
  platforms?: TargetPlatform[];
  /** Windows target configuration */
  win?: WindowsTargetConfig;
  /** macOS target configuration */
  mac?: MacTargetConfig;
  /** Linux target configuration */
  linux?: LinuxTargetConfig;
  /** Optional progress callback invoked during packaging stages */
  onProgress?: (stage: string, detail: string) => void;
}

/**
 * Fully resolved and normalized configuration used internally by builders.
 */
export interface ResolvedPackagerConfig {
  projectDir: string;
  outputDir: string;
  cacheDir: string;
  localNwjsPaths: Record<string, string>;
  appName: string;
  productName: string;
  version: string;
  description: string;
  appId: string;
  author: string;
  homepage: string;
  license: string;
  executableName: string;
  nwVersion: string;
  nwFlavor: NwjsFlavor;
  nwDownloadUrl: string;
  bundlingMode: BundlingMode;
  excludePatterns: string[];
  extraFiles: ExtraFileSpec[];
  icon?: string;
  platforms: TargetPlatform[];
  win: Required<Omit<WindowsTargetConfig, 'icon'>> & { icon?: string };
  mac: Required<Omit<MacTargetConfig, 'icon'>> & { icon?: string };
  linux: Required<Omit<LinuxTargetConfig, 'icon'>> & { icon?: string };
  onProgress?: (stage: string, detail: string) => void;
}

/**
 * Details of a single generated release artifact.
 */
export interface ReleaseArtifact {
  platform: TargetPlatform;
  arch: TargetArch;
  format: PackageFormat;
  filePath: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Result of running the NW.js Release Packager across all requested targets.
 */
export interface PackagerBuildResult {
  appName: string;
  productName: string;
  version: string;
  nwVersion: string;
  nwFlavor: NwjsFlavor;
  bundlingMode: BundlingMode;
  artifacts: ReleaseArtifact[];
  warnings: string[];
  durationMs: number;
}
