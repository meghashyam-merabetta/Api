// PNG is a real 1x1 image; the other samples exercise container signature checks.
export const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=',
  'base64',
);
export const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
export const webp = Buffer.from(
  '5249464616000000574542505650384c0a0000002f00000000071011118888',
  'hex',
);
webp.writeUInt32LE(webp.length - 8, 4);
