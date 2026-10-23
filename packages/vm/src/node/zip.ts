import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Buffer | Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// DOS dates require a nonzero month and day; use 1980-01-01.
const DOS_DATE = (1 << 5) | 1;

export interface ZipFile {
  // Use forward slashes and omit the leading slash in archive paths.
  name: string;
  data: Buffer | Uint8Array | string;
}

interface Entry {
  name: string;
  data: Buffer;
  deflated: Buffer;
  crc: number;
  offset: number;
}

function localHeader(entry: Entry): Buffer {
  const name = Buffer.from(entry.name, 'utf-8');
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4); // Required ZIP version.
  head.writeUInt16LE(0x0800, 6); // UTF-8 filenames.
  head.writeUInt16LE(8, 8); // Deflate compression.
  head.writeUInt16LE(0, 10); // Modification time.
  head.writeUInt16LE(DOS_DATE, 12);
  head.writeUInt32LE(entry.crc, 14);
  head.writeUInt32LE(entry.deflated.length, 18);
  head.writeUInt32LE(entry.data.length, 22);
  head.writeUInt16LE(name.length, 26);
  return Buffer.concat([head, name]);
}

function centralHeader(entry: Entry): Buffer {
  const name = Buffer.from(entry.name, 'utf-8');
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(20, 4); // ZIP creator version.
  head.writeUInt16LE(20, 6); // Required ZIP version.
  head.writeUInt16LE(0x0800, 8);
  head.writeUInt16LE(8, 10);
  head.writeUInt16LE(0, 12); // Modification time.
  head.writeUInt16LE(DOS_DATE, 14);
  head.writeUInt32LE(entry.crc, 16);
  head.writeUInt32LE(entry.deflated.length, 20);
  head.writeUInt32LE(entry.data.length, 24);
  head.writeUInt16LE(name.length, 28);
  head.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([head, name]);
}

export function zipFiles(files: ZipFile[]): Buffer {
  const entries: Entry[] = [];
  const parts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const data = Buffer.isBuffer(file.data)
      ? file.data
      : Buffer.from(file.data as Uint8Array | string);
    const entry: Entry = {
      name: file.name,
      data,
      deflated: zlib.deflateRawSync(data, { level: 9 }),
      crc: crc32(data),
      offset,
    };
    entries.push(entry);
    const head = localHeader(entry);
    parts.push(head, entry.deflated);
    offset += head.length + entry.deflated.length;
  }
  const central = entries.map(centralHeader);
  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}
