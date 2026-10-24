import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BundlingMode,
  NwjsFlavor,
  PackageFormat,
  PackagerConfig,
  TargetPlatform
} from '../types/packager-types.js';
import { NwjsReleasePackager } from '../core/nwjs-release-packager.js';

/**
 * Command-line interface runner for `@nexustools/nwjsreleasepackager`.
 */
export class PackagerCli {
  /**
   * Parses CLI arguments and executes the release packager.
   */
  public static async run(argv: string[]): Promise<number> {
    const args = argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
      PackagerCli.printHelp();
      return 0;
    }

    let explicitConfigPath: string | undefined;
    let initConfig = false;
    let useSyntheticNwjs = false;
    const overrides: PackagerConfig = {};
    let selectedFormats: PackageFormat[] | undefined;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const next = (): string => {
        if (i + 1 >= args.length) {
          throw new Error(`Missing value for flag ${arg}`);
        }
        return args[++i];
      };

      switch (arg) {
        case '--init':
          initConfig = true;
          break;
        case '--project':
        case '-p':
          overrides.projectDir = next();
          break;
        case '--config':
        case '-c':
          explicitConfigPath = next();
          break;
        case '--output':
        case '-o':
          overrides.outputDir = next();
          break;
        case '--cache-dir':
          overrides.cacheDir = next();
          break;
        case '--nw-version':
        case '-v':
          overrides.nwVersion = next();
          break;
        case '--flavor':
          overrides.nwFlavor = next() as NwjsFlavor;
          break;
        case '--mode':
          overrides.bundlingMode = next() as BundlingMode;
          break;
        case '--platforms':
          overrides.platforms = next()
            .split(',')
            .map((s) => s.trim() as TargetPlatform)
            .filter(Boolean);
          break;
        case '--formats':
          selectedFormats = next()
            .split(',')
            .map((s) => s.trim() as PackageFormat)
            .filter(Boolean);
          break;
        case '--icon':
          overrides.icon = next();
          break;
        case '--app-name':
          overrides.appName = next();
          break;
        case '--product-name':
          overrides.productName = next();
          break;
        case '--app-id':
          overrides.appId = next();
          break;
        case '--synthetic-nwjs':
          useSyntheticNwjs = true;
          break;
        default:
          if (!arg.startsWith('-') && !overrides.projectDir) {
            overrides.projectDir = arg;
          }
          break;
      }
    }

    if (initConfig) {
      const targetDir = path.resolve(overrides.projectDir ?? process.cwd());
      const outPath = path.join(targetDir, 'nwjsreleasepackager.json');
      const starterConfig: PackagerConfig = {
        nwVersion: '0.93.0',
        nwFlavor: 'normal',
        bundlingMode: 'plain',
        outputDir: 'release',
        platforms: ['win', 'osx', 'linux'],
        win: {
          arch: ['x64'],
          formats: ['win-zip', 'win-msi'],
          createDesktopShortcut: true,
          createStartMenuShortcut: true
        },
        mac: {
          arch: ['x64', 'arm64'],
          formats: ['mac-dmg']
        },
        linux: {
          arch: ['x64'],
          formats: ['linux-deb', 'linux-flatpak', 'linux-zip']
        }
      };
      fs.writeFileSync(outPath, JSON.stringify(starterConfig, null, 2) + '\n', 'utf8');
      console.log(`Created starter configuration at ${outPath}`);
      return 0;
    }

    if (selectedFormats && selectedFormats.length > 0) {
      const winFormats = selectedFormats.filter(
        (f): f is 'win-zip' | 'win-msi' => f === 'win-zip' || f === 'win-msi'
      );
      const macFormats = selectedFormats.filter(
        (f): f is 'mac-dmg' => f === 'mac-dmg'
      );
      const linuxFormats = selectedFormats.filter(
        (f): f is 'linux-deb' | 'linux-flatpak' | 'linux-zip' =>
          f === 'linux-deb' || f === 'linux-flatpak' || f === 'linux-zip'
      );
      overrides.win = { ...(overrides.win ?? {}), formats: winFormats };
      overrides.mac = { ...(overrides.mac ?? {}), formats: macFormats };
      overrides.linux = { ...(overrides.linux ?? {}), formats: linuxFormats };
    }

    overrides.onProgress = (stage: string, detail: string) => {
      console.log(`[${stage}] ${detail}`);
    };

    const packager = new NwjsReleasePackager(overrides, explicitConfigPath);
    const result = await packager.packageAll({
      useSyntheticNwjsIfOffline: useSyntheticNwjs
    });

    if (result.warnings.length > 0) {
      console.warn('\nWarnings:');
      for (const w of result.warnings) {
        console.warn(`  - ${w}`);
      }
    }

    console.log(
      `\nPackaged ${result.productName} v${result.version} (NW.js v${result.nwVersion}, ${result.nwFlavor}, mode=${result.bundlingMode}) in ${result.durationMs}ms:`
    );
    for (const artifact of result.artifacts) {
      const kb = (artifact.sizeBytes / 1024).toFixed(1);
      console.log(
        `  - [${artifact.format}] ${artifact.fileName} (${kb} KB) sha256:${artifact.sha256.slice(0, 16)}...`
      );
    }

    return 0;
  }

  private static printHelp(): void {
    console.log(`
@nexustools/nwjsreleasepackager - Pure Node.js Cross-Platform NW.js Release Packager

Usage:
  nwjsreleasepackager [projectDir] [options]

Options:
  -p, --project <dir>         Path to NW.js project directory (default: current directory)
  -c, --config <file>         Path to explicit config JSON file
  -o, --output <dir>          Output directory for release packages (default: ./release)
  -v, --nw-version <ver>      NW.js version ('0.93.0', 'latest', 'lts')
  --flavor <normal|sdk>       NW.js build flavor (default: normal)
  --mode <plain|zip|fused>    App bundling mode per NW.js docs (default: plain)
  --platforms <list>          Comma-separated platforms: win,osx,linux
  --formats <list>            Comma-separated formats: win-zip,win-msi,mac-dmg,linux-deb,linux-flatpak,linux-zip
  --icon <file>               Default application icon (.png, .ico, .icns)
  --app-name <slug>           Override application internal name
  --product-name <name>       Override human-readable display name
  --app-id <id>               Override reverse-DNS application ID (e.g. io.nexustools.app)
  --synthetic-nwjs            Fallback to synthetic NW.js runtime template if offline
  --init                      Generate a starter nwjsreleasepackager.json in projectDir
  -h, --help                  Display this help message
`);
  }
}
