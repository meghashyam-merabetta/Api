# Handoff: CMS Frontend Agent

## Objective

Integrate the Merabetta enrollment UI with the backend's resumable, direct-to-S3 upload protocol. New enrollment files must be uploaded sequentially and cached in IndexedDB so browser refreshes and temporary network failures do not force the administrator or enrollment user to select and upload every file again.

This handoff applies to the Next.js 16, React 19, TypeScript, and Tailwind CSS CMS/CRM frontend described by the project owner. Relevant frontend areas are expected to be under `src/app/`, `src/components/`, `src/services/api/`, `src/lib/api.ts`, and `src/types/`.

## Backend endpoints

All paths below are relative to the frontend's existing backend proxy.

| Method   | Endpoint                                        | Purpose                                                  |
| -------- | ----------------------------------------------- | -------------------------------------------------------- |
| `POST`   | `/api/app/enrollments/upload-sessions`          | Create one shared upload session for the enrollment form |
| `POST`   | `/api/app/enrollments/upload-sessions/files`    | Initiate one file and receive its signed `fileToken`     |
| `POST`   | `/api/app/enrollments/upload-sessions/part-url` | Get a 15-minute S3 URL for one chunk                     |
| `POST`   | `/api/app/enrollments/upload-sessions/complete` | Complete a file and receive its signed receipt           |
| `DELETE` | `/api/app/enrollments/upload-sessions/file`     | Abort an unfinished file upload                          |
| `POST`   | `/api/app/enrollments/with-uploaded-files`      | Submit enrollment JSON and all completed-file receipts   |

The legacy JSON endpoint and single-request multipart endpoint remain available, but new UI work should use the chunk protocol.

## Important Next.js proxy rule

The API control requests above can use the existing Next.js proxy and shared API client. The returned presigned S3 URL must **not** be passed through `src/lib/api.ts` or rewritten to the backend. Upload each chunk with a plain `fetch(signedUrl, { method: 'PUT', body: chunk })` directly to S3. Do not attach the CMS authorization cookie, bearer token, or JSON `Content-Type` to that S3 request.

## Required client workflow

1. Create one upload session when the user begins uploading.
2. Save the returned `sessionToken`; it is shared by every file in that enrollment.
3. Process files one at a time.
4. Process each file's chunks one at a time using the backend-provided `chunkSize`—currently 8 MiB.
5. Persist progress after every successful chunk.
6. Complete the file and save its receipt.
7. After every required file has a receipt, submit `{ payload, receipts }` to `/with-uploaded-files`.
8. Clear cached enrollment files only after the final endpoint returns `201`.

Do not use `Promise.all` for all files or chunks. Sequential processing limits memory, bandwidth spikes, presigned URL expiry, and rate-limit pressure.

## IndexedDB cache

Use IndexedDB because `File`/`Blob` objects are too large for `localStorage`, and the Cache API is intended for HTTP request/response caching rather than form upload state.

Suggested record shape:

```ts
export interface CachedEnrollmentUpload {
  draftId: string;
  sessionToken: string;
  field: EnrollmentUploadField;
  file: Blob;
  fileName: string;
  contentType: string;
  size: number;
  fileToken?: string;
  chunkSize?: number;
  partCount?: number;
  completedParts: Array<{ partNumber: number; etag: string }>;
  receipt?: string;
  status: 'pending' | 'uploading' | 'completed' | 'failed';
  updatedAt: string;
}
```

On page reload, restore the draft and continue from the first part not present in `completedParts`. Request a new part URL before retrying because old URLs expire after 15 minutes. Uploading the same part number again is safe; S3 replaces that incomplete part.

## File field contract

```ts
export type EnrollmentUploadField =
  | 'facilityPhotographs'
  | 'facilityVideo'
  | 'registrationCertificate'
  | 'panCard'
  | 'gstCertificate'
  | 'addressProof'
  | 'representativeIdProof'
  | 'bankAccountDetails'
  | 'licensesCertificates'
  | 'digitalSignature';
```

| Field                    |          Count | Accepted types                  |     Maximum |
| ------------------------ | -------------: | ------------------------------- | ----------: |
| `facilityPhotographs`    |           0–10 | JPEG, PNG, WebP                 | 10 MiB each |
| `facilityVideo`          |            0–1 | MP4                             |     500 MiB |
| Required document fields | exactly 1 each | PDF, JPEG, PNG, WebP, DOC, DOCX | 10 MiB each |
| `gstCertificate`         |            0–1 | PDF, JPEG, PNG, WebP, DOC, DOCX |      10 MiB |
| `licensesCertificates`   |           0–10 | PDF, JPEG, PNG, WebP, DOC, DOCX | 10 MiB each |
| `digitalSignature`       |      exactly 1 | JPEG                            |       5 MiB |

Required documents are `registrationCertificate`, `panCard`, `addressProof`, `representativeIdProof`, and `bankAccountDetails`.

## Digital signature

Convert the signature canvas to a JPEG Blob with a white background before initiating its upload. Do not upload the transparent PNG emitted by the current canvas.

```ts
export async function signatureCanvasToJpeg(canvas: HTMLCanvasElement) {
  const output = document.createElement('canvas');
  output.width = canvas.width;
  output.height = canvas.height;
  const context = output.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, output.width, output.height);
  context.drawImage(canvas, 0, 0);
  return new Promise<Blob>((resolve, reject) =>
    output.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Signature conversion failed'))),
      'image/jpeg',
      0.9,
    ),
  );
}
```

## API service outline

Add a focused service such as `src/services/api/enrollmentUploads.ts` rather than placing the protocol inside a page component.

```ts
async function uploadFileSequentially(
  file: Blob,
  fileName: string,
  field: EnrollmentUploadField,
  sessionToken: string,
  saveProgress: (state: Partial<CachedEnrollmentUpload>) => Promise<void>,
) {
  const initiated = await apiRequest('/api/app/enrollments/upload-sessions/files', {
    method: 'POST',
    body: { sessionToken, field, fileName, contentType: file.type, size: file.size },
  });

  const parts: Array<{ partNumber: number; etag: string }> = [];
  for (let partNumber = 1; partNumber <= initiated.partCount; partNumber++) {
    const signed = await apiRequest('/api/app/enrollments/upload-sessions/part-url', {
      method: 'POST',
      body: { fileToken: initiated.fileToken, partNumber },
    });
    const start = (partNumber - 1) * initiated.chunkSize;
    const chunk = file.slice(start, Math.min(start + initiated.chunkSize, file.size));
    const response = await fetch(signed.url, { method: 'PUT', body: chunk });
    if (!response.ok) throw new Error(`Upload part ${partNumber} failed`);
    const etag = response.headers.get('ETag');
    if (!etag) throw new Error('S3 did not expose ETag');
    parts.push({ partNumber, etag });
    await saveProgress({ fileToken: initiated.fileToken, completedParts: parts });
  }

  return apiRequest('/api/app/enrollments/upload-sessions/complete', {
    method: 'POST',
    body: { fileToken: initiated.fileToken, parts },
  });
}
```

Adapt the `apiRequest` call shape to the actual helper in `src/lib/api.ts`. Preserve cookies for backend control requests. Do not apply the helper's normal timeout to direct S3 `PUT`s; use an `AbortController` with a chunk-appropriate timeout and retry policy.

## UX expectations

- Show overall file progress and current-file chunk progress.
- Distinguish paused/offline, retrying, failed, completed, and submitting states.
- Disable final submission until every required field has a receipt.
- Allow replacing a selected file; abort its old unfinished upload and remove its IndexedDB record.
- Warn before closing the page while a chunk is actively uploading.
- Resume automatically when connectivity returns, but do not upload multiple files concurrently.
- Keep the form payload and upload cache under a stable client-generated `draftId`.

## Admin enrollment pages

The existing admin enrollment APIs are unchanged:

- `GET /api/admin/enrollments`
- `GET /api/admin/enrollments/:id`
- `PATCH /api/admin/enrollments/:id/status`
- `PUT /api/admin/enrollments/:id`
- `DELETE /api/admin/enrollments/:id`
- `POST /api/admin/enrollments/:id/restore`

Admin media editing is available through:

- `PUT /api/admin/enrollments/:id/media`

Upload replacement files through the same chunk protocol first, then send their completion receipts to this authenticated admin endpoint. Do not send receipts to the ordinary enrollment `PUT` endpoint.

```ts
await apiRequest(`/api/admin/enrollments/${enrollmentId}/media`, {
  method: 'PUT',
  body: {
    receipts,
    // For array fields being edited, list existing URLs that must remain.
    retain: {
      facilityPhotographs: retainedPhotoUrls,
      licensesCertificates: retainedLicenseUrls,
    },
    // Optional fields and arrays can be removed explicitly.
    clearFields: fieldsToClear,
  },
});
```

Receipt fields replace their corresponding single-file value. For `facilityPhotographs` and `licensesCertificates`, omitted `retain` values preserve all current files by default; send a selected URL subset to remove/reorder existing files, or include the field in `clearFields` to replace the entire array with newly uploaded receipts. The clearable fields are `facilityPhotographs`, `facilityVideo`, `gstCertificate`, and `licensesCertificates`. Required identity/banking documents and the signature can be replaced but not cleared.

The detail response continues to expose file URLs in the existing camelCase fields. In the CMS enrollment detail page:

- Render facility photographs as an image gallery.
- Render facility video with a video player or explicit download/open action.
- Render documents and signature as safe links/previews based on their known field type.
- Provide replace/remove controls according to the media rules above; this page is no longer view-only.
- Do not reconstruct S3 URLs; always use the returned backend value.

## Deployment dependency

The S3 bucket must allow direct `PUT` from the deployed frontend origins and expose `ETag`. It must also have an `AbortIncompleteMultipartUpload` lifecycle rule, recommended after one day. Without the CORS rule, the browser cannot complete the protocol even though backend endpoint tests pass.

## Acceptance checklist

- A 500 MiB MP4 never passes through Next.js or the backend process.
- Refreshing midway through a file resumes from IndexedDB progress.
- Failed chunks retry individually without restarting completed files.
- Files upload sequentially.
- The signature is stored as JPEG.
- Required receipts gate final submission.
- A successful final submission returns `{ id, status: 'INACTIVE' }` and clears the draft cache.
- Admin enrollment list/detail/status/update/delete/restore behavior remains working.

The backend implementation and tests are in `src/app/enrollments/`, `src/admin/enrollments/enrollments.schema.js`, and `scripts/enrollment-uploads.test.js`. The focused backend suite currently passes all five enrollment upload tests.
