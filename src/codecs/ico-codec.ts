import * as zlib from 'node:zlib';
import { Crc32Codec } from './crc32-codec.js';

/**
 * Pure Node.js Windows `.ico` and PNG icon codec.
 * Supports wrapping PNGs into `.ico`, parsing `.ico` entries for PE `RT_ICON` / `RT_GROUP_ICON`,
 * and generating a default fallback PNG icon when none is provided.
 */
export class IcoCodec {
  /**
   * Ensures the returned buffer is a valid Windows `.ico` file.
   * If a PNG buffer is passed, wraps it in an ICONDIR container.
   */
  public static toIcoBuffer(inputBuffer?: Buffer): Buffer {
    const buf = inputBuffer ?? IcoCodec.createDefaultPngIcon(64);
    if (IcoCodec.isIco(buf)) {
      return buf;
    }
    if (IcoCodec.isPng(buf)) {
      const { width, height } = IcoCodec.readPngDimensions(buf);
      const header = Buffer.alloc(6 + 16);
      header.writeUInt16LE(0, 0); // Reserved
      header.writeUInt16LE(1, 2); // Type 1 = ICO
      header.writeUInt16LE(1, 4); // Count = 1

      header.writeUInt8(width >= 256 ? 0 : width, 6);
      header.writeUInt8(height >= 256 ? 0 : height, 7);
      header.writeUInt8(0, 8); // Color count
      header.writeUInt8(0, 9); // Reserved
      header.writeUInt16LE(1, 10); // Color planes
      header.writeUInt16LE(32, 12); // Bits per pixel
      header.writeUInt32LE(buf.length, 14); // Bytes in resource
      header.writeUInt32LE(22, 18); // Image offset

      return Buffer.concat([header, buf]);
    }
    // Fallback if unrecognized format
    return IcoCodec.toIcoBuffer(IcoCodec.createDefaultPngIcon(64));
  }

  /**
   * Ensures the returned buffer is a valid PNG image (extracting from `.ico` or generating default if needed).
   */
  public static toPngBuffer(inputBuffer?: Buffer): Buffer {
    if (!inputBuffer) {
      return IcoCodec.createDefaultPngIcon(256);
    }
    if (IcoCodec.isPng(inputBuffer)) {
      return inputBuffer;
    }
    if (IcoCodec.isIco(inputBuffer)) {
      const entries = IcoCodec.parseIcoEntries(inputBuffer);
      for (const entry of entries) {
        if (IcoCodec.isPng(entry.imageData)) {
          return entry.imageData;
        }
      }
    }
    return IcoCodec.createDefaultPngIcon(256);
  }

  /**
   * Parses an `.ico` buffer into individual icon images and builds the `GRPICONDIR`
   * structure required for PE `RT_GROUP_ICON` resources.
   */
  public static parseIcoForPeResource(icoBuffer: Buffer): {
    grpIconDir: Buffer;
    icons: { id: number; data: Buffer }[];
  } {
    const entries = IcoCodec.parseIcoEntries(icoBuffer);
    const grpHeader = Buffer.alloc(6 + entries.length * 14);
    grpHeader.writeUInt16LE(0, 0);
    grpHeader.writeUInt16LE(1, 2);
    grpHeader.writeUInt16LE(entries.length, 4);

    const icons: { id: number; data: Buffer }[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const iconId = i + 1;
      const offset = 6 + i * 14;
      grpHeader.writeUInt8(e.width, offset);
      grpHeader.writeUInt8(e.height, offset + 1);
      grpHeader.writeUInt8(e.colorCount, offset + 2);
      grpHeader.writeUInt8(0, offset + 3);
      grpHeader.writeUInt16LE(e.planes || 1, offset + 4);
      grpHeader.writeUInt16LE(e.bitCount || 32, offset + 6);
      grpHeader.writeUInt32LE(e.imageData.length, offset + 8);
      grpHeader.writeUInt16LE(iconId, offset + 12);

      icons.push({ id: iconId, data: e.imageData });
    }

    return { grpIconDir: grpHeader, icons };
  }

  /**
   * Synthesizes a valid RGBA PNG icon in pure Node.js (gradient rounded badge).
   */
  public static createDefaultPngIcon(size = 64): Buffer {
    const rawScanlines = Buffer.alloc(size * (1 + size * 4));
    const center = (size - 1) / 2;
    const radius = size * 0.45;

    for (let y = 0; y < size; y++) {
      const rowOffset = y * (1 + size * 4);
      rawScanlines[rowOffset] = 0; // Filter type 0 (None)
      for (let x = 0; x < size; x++) {
        const pxOffset = rowOffset + 1 + x * 4;
        const dx = x - center;
        const dy = y - center;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= radius) {
          const t = y / size;
          rawScanlines[pxOffset] = Math.round(28 + t * 20); // R
          rawScanlines[pxOffset + 1] = Math.round(135 - t * 35); // G
          rawScanlines[pxOffset + 2] = Math.round(230 - t * 40); // B
          rawScanlines[pxOffset + 3] = 255; // A
        } else {
          rawScanlines[pxOffset] = 0;
          rawScanlines[pxOffset + 1] = 0;
          rawScanlines[pxOffset + 2] = 0;
          rawScanlines[pxOffset + 3] = 0;
        }
      }
    }

    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr.writeUInt8(8, 8); // Bit depth 8
    ihdr.writeUInt8(6, 9); // Color type 6 (RGBA)
    ihdr.writeUInt8(0, 10); // Compression
    ihdr.writeUInt8(0, 11); // Filter
    ihdr.writeUInt8(0, 12); // Interlace

    const idatPayload = zlib.deflateSync(rawScanlines, { level: 6 });

    return Buffer.concat([
      signature,
      IcoCodec.makePngChunk('IHDR', ihdr),
      IcoCodec.makePngChunk('IDAT', idatPayload),
      IcoCodec.makePngChunk('IEND', Buffer.alloc(0))
    ]);
  }

  public static isPng(buf: Buffer): boolean {
    return (
      buf.length >= 24 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    );
  }

  public static isIco(buf: Buffer): boolean {
    return (
      buf.length >= 22 &&
      buf.readUInt16LE(0) === 0 &&
      buf.readUInt16LE(2) === 1 &&
      buf.readUInt16LE(4) >= 1
    );
  }

  private static readPngDimensions(png: Buffer): { width: number; height: number } {
    if (!IcoCodec.isPng(png)) {
      return { width: 256, height: 256 };
    }
    return {
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20)
    };
  }

  private static parseIcoEntries(ico: Buffer): {
    width: number;
    height: number;
    colorCount: number;
    planes: number;
    bitCount: number;
    imageData: Buffer;
  }[] {
    const count = ico.readUInt16LE(4);
    const list: {
      width: number;
      height: number;
      colorCount: number;
      planes: number;
      bitCount: number;
      imageData: Buffer;
    }[] = [];

    for (let i = 0; i < count; i++) {
      const base = 6 + i * 16;
      if (base + 16 > ico.length) {
        break;
      }
      const width = ico.readUInt8(base);
      const height = ico.readUInt8(base + 1);
      const colorCount = ico.readUInt8(base + 2);
      const planes = ico.readUInt16LE(base + 4);
      const bitCount = ico.readUInt16LE(base + 6);
      const size = ico.readUInt32LE(base + 8);
      const offset = ico.readUInt32LE(base + 12);
      const imageData = ico.subarray(offset, offset + size);
      list.push({ width, height, colorCount, planes, bitCount, imageData });
    }
    return list;
  }

  private static makePngChunk(type: string, data: Buffer): Buffer {
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write(type, 4, 4, 'ascii');
    data.copy(chunk, 8);
    const crc = Crc32Codec.compute(chunk.subarray(4, 8 + data.length));
    chunk.writeUInt32BE(crc, 8 + data.length);
    return chunk;
  }
}
