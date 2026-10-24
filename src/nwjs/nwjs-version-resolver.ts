import * as https from 'node:https';
import { NwjsFlavor, TargetArch, TargetPlatform } from '../types/packager-types.js';

/**
 * Resolves NW.js version identifiers ('latest', 'lts', or explicit version strings)
 * and constructs official download URLs and archive names per `dl.nwjs.io`.
 */
export class NwjsVersionResolver {
  private static readonly FALLBACK_VERSION = '0.93.0';

  /**
   * Resolves a requested NW.js version string to a concrete semantic version (without leading 'v').
   */
  public static async resolveVersion(requestedVersion: string): Promise<string> {
    const trimmed = requestedVersion.trim().replace(/^v/i, '');
    if (trimmed !== 'latest' && trimmed !== 'lts' && /^\d+\.\d+\.\d+/.test(trimmed)) {
      return trimmed;
    }

    try {
      const manifestRaw = await NwjsVersionResolver.fetchText('https://nwjs.io/versions.json');
      const manifest = JSON.parse(manifestRaw) as {
        latest?: string;
        lts?: string;
      };
      const picked =
        trimmed === 'lts'
          ? manifest.lts ?? manifest.latest
          : manifest.latest ?? manifest.lts;
      if (picked) {
        return picked.replace(/^v/i, '');
      }
    } catch {
      // Fallback to stable default when offline
    }

    return NwjsVersionResolver.FALLBACK_VERSION;
  }

  /**
   * Returns the official NW.js archive base folder name and filename for a target.
   */
  public static getArchiveInfo(
    version: string,
    flavor: NwjsFlavor,
    platform: TargetPlatform,
    arch: TargetArch,
    baseUrl = 'https://dl.nwjs.io'
  ): {
    folderName: string;
    archiveFileName: string;
    downloadUrl: string;
    isTarGz: boolean;
  } {
    const cleanVersion = version.replace(/^v/i, '');
    const prefix = flavor === 'sdk' ? 'nwjs-sdk' : 'nwjs';
    const folderName = `${prefix}-v${cleanVersion}-${platform}-${arch}`;
    const isTarGz = platform === 'linux';
    const ext = isTarGz ? 'tar.gz' : 'zip';
    const archiveFileName = `${folderName}.${ext}`;
    const downloadUrl = `${baseUrl.replace(/\/+$/, '')}/v${cleanVersion}/${archiveFileName}`;

    return {
      folderName,
      archiveFileName,
      downloadUrl,
      isTarGz
    };
  }

  private static fetchText(url: string, redirectsLeft = 5): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { timeout: 10000 }, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects fetching ${url}`));
            return;
          }
          res.resume();
          NwjsVersionResolver.fetchText(res.headers.location, redirectsLeft - 1).then(
            resolve,
            reject
          );
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error(`Timeout fetching ${url}`));
      });
    });
  }
}
