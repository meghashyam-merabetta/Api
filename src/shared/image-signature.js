import { HttpError } from './errors.js';

export function validateImageContent(file) {
  const bytes = file.buffer;
  let detected;
  if (
    bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.toString('ascii', 12, 16) === 'IHDR' &&
    bytes.readUInt32BE(16) > 0 &&
    bytes.readUInt32BE(20) > 0
  )
    detected = 'image/png';
  else if (
    bytes.length >= 6 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  )
    detected = 'image/jpeg';
  else if (
    bytes.length >= 20 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP' &&
    bytes.readUInt32LE(4) === bytes.length - 8 &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16)) &&
    bytes.readUInt32LE(16) <= bytes.length - 20
  )
    detected = 'image/webp';
  if (!detected || detected !== file.mimetype)
    throw new HttpError(400, 'Image content must match its JPEG, PNG, or WebP MIME type');
  return detected;
}
