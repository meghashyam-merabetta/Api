# Enrollment upload frontend handoff

Use the resumable S3 multipart flow below for the four-page enrollment form. Files go directly from the browser to S3 in sequential 8 MiB chunks; they do not pass through the API server. This avoids Render/server body limits and allows a refresh or interrupted connection to resume.

The old JSON and single-request multipart endpoints remain for compatibility. New clients should finish with `POST /api/app/enrollments/with-uploaded-files`.

## Required browser caching

Store the selected `File` objects as `Blob`s in IndexedDB, not `localStorage` or the Service Worker HTTP cache. Persist this state after every successful chunk:

- `sessionToken`, file field/name/type/size and `fileToken`
- next part number
- completed `{ partNumber, etag }` entries
- final receipt for each completed file

Upload one file at a time and one chunk at a time. On reload, read the Blob and state from IndexedDB, request a fresh URL for the next unfinished part, and continue. Delete cached Blobs only after the final enrollment endpoint returns `201`.

## Chunk protocol

1. `POST /api/app/enrollments/upload-sessions` with `{}`. Save `sessionToken` and `chunkSize` (8 MiB).
2. For each file, call `POST /upload-sessions/files` with `{ sessionToken, field, fileName, contentType, size }`. Save `fileToken` and `partCount`.
3. Slice the file using `file.slice(start, end)`. For each part, call `POST /upload-sessions/part-url` with `{ fileToken, partNumber }`.
4. `PUT` that Blob directly to the returned S3 URL. Do not add authorization. Save the `ETag` response header without altering it.
5. After every part succeeds, call `POST /upload-sessions/complete` with `{ fileToken, parts }`. Save the returned signed `receipt`.
6. After all files finish, call `POST /api/app/enrollments/with-uploaded-files` as JSON: `{ payload: { poc_client, poc_admin }, receipts }`.
7. To cancel an unfinished file, call `DELETE /upload-sessions/file` with JSON `{ fileToken }`.

Part URLs last 15 minutes, file tokens last 2 hours, and sessions/completion receipts last 24 hours. Requesting a new part URL is safe. Do not restart already completed parts. S3 must allow the frontend origin for `PUT` and expose the `ETag` response header in bucket CORS.

Deployment must configure the bucket with an `AbortIncompleteMultipartUpload` lifecycle rule (recommended: one day) so abandoned sessions do not retain billable parts. Bucket CORS must allow `PUT` from the production and preview frontend origins, allow the `Content-Type` header, and expose `ETag`.

```js
async function uploadFileSequentially(file, field, sessionToken, saveProgress) {
  const init = await api('/api/app/enrollments/upload-sessions/files', {
    sessionToken,
    field,
    fileName: file.name,
    contentType: file.type,
    size: file.size,
  });
  const parts = [];
  for (let partNumber = 1; partNumber <= init.partCount; partNumber++) {
    const signed = await api('/api/app/enrollments/upload-sessions/part-url', {
      fileToken: init.fileToken,
      partNumber,
    });
    const start = (partNumber - 1) * init.chunkSize;
    const upload = await fetch(signed.url, {
      method: 'PUT',
      body: file.slice(start, Math.min(start + init.chunkSize, file.size)),
    });
    if (!upload.ok) throw new Error(`Chunk ${partNumber} failed`);
    const etag = upload.headers.get('ETag');
    if (!etag) throw new Error('S3 CORS must expose ETag');
    parts.push({ partNumber, etag });
    await saveProgress({ fileToken: init.fileToken, parts });
  }
  return api('/api/app/enrollments/upload-sessions/complete', {
    fileToken: init.fileToken,
    parts,
  });
}
```

Convert the signature canvas to a white-background JPEG Blob before initiating it. The `digitalSignature` chunk upload accepts only `image/jpeg` so the stored signature is always JPEG.

## FormData contract

Append the complete non-file enrollment object once as JSON under `payload`. Omit all URL/file properties from that JSON (`facilityPhotographs`, `facilityVideo`, every document field, `licensesCertificates`, and `digitalSignature`). Then append files using these exact case-sensitive names:

| Field                     |     Count | Accepted content                |      Limit |
| ------------------------- | --------: | ------------------------------- | ---------: |
| `facilityPhotographs`     |      0–10 | JPEG, PNG, WebP                 |  5 MB each |
| `facilityVideo`           |       0–1 | MP4                             |     100 MB |
| `registrationCertificate` | exactly 1 | PDF, JPEG, PNG, WebP, DOC, DOCX |      10 MB |
| `panCard`                 | exactly 1 | PDF, JPEG, PNG, WebP, DOC, DOCX |      10 MB |
| `gstCertificate`          |       0–1 | PDF, JPEG, PNG, WebP, DOC, DOCX |      10 MB |
| `addressProof`            | exactly 1 | PDF, JPEG, PNG, WebP, DOC, DOCX |      10 MB |
| `representativeIdProof`   | exactly 1 | PDF, JPEG, PNG, WebP, DOC, DOCX |      10 MB |
| `bankAccountDetails`      | exactly 1 | PDF, JPEG, PNG, WebP, DOC, DOCX |      10 MB |
| `licensesCertificates`    |      0–10 | PDF, JPEG, PNG, WebP, DOC, DOCX | 10 MB each |
| `digitalSignature`        | exactly 1 | JPEG, PNG, WebP                 |       5 MB |

File contents are checked against their declared MIME type. Renaming an executable or text file to `.pdf`/`.jpg` will be rejected. The API always converts `digitalSignature` to a white-background JPEG before storage. As a compatibility option, a canvas image data URI may be sent at `poc_admin.digitalSignature`; sending a Blob file is preferred.

```js
const body = new FormData();
body.append('payload', JSON.stringify({ poc_client, poc_admin }));
for (const photo of facilityPhotographs) body.append('facilityPhotographs', photo);
if (facilityVideo) body.append('facilityVideo', facilityVideo);
body.append('registrationCertificate', registrationCertificate);
body.append('panCard', panCard);
if (gstCertificate) body.append('gstCertificate', gstCertificate);
body.append('addressProof', addressProof);
body.append('representativeIdProof', representativeIdProof);
body.append('bankAccountDetails', bankAccountDetails);
for (const file of licensesCertificates) body.append('licensesCertificates', file);
body.append('digitalSignature', signatureBlob, 'signature.png');

const response = await fetch(`${API_BASE}/api/app/enrollments/with-files`, {
  method: 'POST',
  body,
});
const result = await response.json();
if (!response.ok) throw new Error(result.error || 'Enrollment failed');
// 201: { id: '<uuid>', status: 'INACTIVE' }
```

Admin endpoint contracts are unchanged: `GET /api/admin/enrollments`, `GET /:id`, `PATCH /:id/status`, `PUT /:id`, `DELETE /:id`, and `POST /:id/restore`. The detail response contains durable storage URLs in the existing camelCase file properties.

Admins can edit existing enrollment media with `PUT /api/admin/enrollments/:id/media`. Complete replacement files through the same chunk protocol and send their receipts in `{ receipts, retain, clearFields }`. `retain` supports existing `facilityPhotographs` and `licensesCertificates` URLs; `clearFields` supports those arrays plus `facilityVideo` and `gstCertificate`. Required documents and the signature may be replaced but not cleared.
