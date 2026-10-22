import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
export { crc32 } from '@tess/vm';
import { zipFiles } from '@tess/vm';

function walk(dir: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) {
      found.push(...walk(path.join(dir, item.name), name));
    } else {
      found.push(name);
    }
  }
  return found;
}

export function zipDirectory(dir: string, target: string): void {
  fs.writeFileSync(
    target,
    zipFiles(walk(dir).map((name) => ({ name, data: fs.readFileSync(path.join(dir, name)) }))),
  );
}

// CRX3 adds a signed protobuf header before the ZIP; its fields are length-delimited.
const CRX_MAGIC = 'Cr24';
const CRX_VERSION = 3;
// This fixed prefix is part of the signed CRX3 payload.
const SIGN_PREFIX = Buffer.from('CRX3 SignedData\0', 'binary');

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    const byte = rest & 0x7f;
    rest >>>= 7;
    bytes.push(rest > 0 ? byte | 0x80 : byte);
  } while (rest > 0);
  return Buffer.from(bytes);
}

function field(number: number, data: Buffer): Buffer {
  return Buffer.concat([varint((number << 3) | 2), varint(data.length), data]);
}

// The signed header stores the extension ID derived from the public key.
function crxId(publicKey: Buffer): Buffer {
  return crypto.createHash('sha256').update(publicKey).digest().subarray(0, 16);
}

// Chrome maps hexadecimal ID digits onto letters a through p.
export function crxIdText(publicKey: Buffer): string {
  return [...crxId(publicKey)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
}

export function publicKeyOf(privateKeyPem: string): Buffer {
  return crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' });
}

export function packCrx(archive: Buffer, privateKeyPem: string): Buffer {
  const publicKey = publicKeyOf(privateKeyPem);
  const signedHeaderData = field(1, crxId(publicKey));
  const headerSize = Buffer.alloc(4);
  headerSize.writeUInt32LE(signedHeaderData.length, 0);
  const signature = crypto.sign(
    'sha256',
    Buffer.concat([SIGN_PREFIX, headerSize, signedHeaderData, archive]),
    privateKeyPem,
  );
  const header = Buffer.concat([
    // RSA proof field 2 contains public key field 1 and signature field 2.
    field(2, Buffer.concat([field(1, publicKey), field(2, signature)])),
    field(10000, signedHeaderData),
  ]);
  const head = Buffer.alloc(12);
  head.write(CRX_MAGIC, 0, 'binary');
  head.writeUInt32LE(CRX_VERSION, 4);
  head.writeUInt32LE(header.length, 8);
  return Buffer.concat([head, header, archive]);
}

export function signingKey(file: string): string {
  if (!fs.existsSync(file)) {
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    fs.writeFileSync(file, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf-8');
}
