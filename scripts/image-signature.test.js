import test from 'node:test';
import assert from 'node:assert/strict';
import { validateImageContent } from '../src/shared/image-signature.js';
import { png, jpeg, webp } from '../test-support/image-fixtures.js';

test('image signatures match declared MIME and reject spoofed, truncated and inconsistent containers', () => {
  for (const [buffer, mimetype] of [
    [png, 'image/png'],
    [jpeg, 'image/jpeg'],
    [webp, 'image/webp'],
  ]) {
    assert.equal(validateImageContent({ buffer, mimetype }), mimetype);
    assert.throws(
      () => validateImageContent({ buffer: buffer.subarray(0, 5), mimetype }),
      { status: 400 },
    );
    assert.throws(
      () =>
        validateImageContent({
          buffer: Buffer.from('<script>alert(1)</script>'),
          mimetype,
        }),
      { status: 400 },
    );
  }
  assert.throws(() => validateImageContent({ buffer: png, mimetype: 'image/jpeg' }), {
    status: 400,
  });
  const bad = Buffer.from(webp);
  bad.writeUInt32LE(99999, 4);
  assert.throws(() => validateImageContent({ buffer: bad, mimetype: 'image/webp' }), {
    status: 400,
  });
});
