import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { once } from 'node:events';
import {
  enrollmentMultipart,
  signatureAsJpeg,
} from '../src/app/enrollments/enrollment-upload.js';
import {
  enrollmentBodySchema,
  enrollmentMediaUpdateSchema,
  enrollmentMultipartBodySchema,
} from '../src/admin/enrollments/enrollments.schema.js';
import { appEnrollmentsRoutes } from '../src/app/enrollments/enrollments.routes.js';
import { enrollmentsRoutes } from '../src/admin/enrollments/enrollments.routes.js';
import {
  createEnrollmentUploadSession,
  initiateEnrollmentFile,
  ENROLLMENT_CHUNK_BYTES,
} from '../src/app/enrollments/enrollment-chunks.js';
import { s3 } from '../src/shared/image_upload.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const payload = {
  poc_client: {
    homeName: 'Test Home',
    yearEstablished: 2020,
    organizationType: 'Private',
    address: '1 Test Road',
    city: 'Pune',
    state: 'Maharashtra',
    pinCode: '411001',
    totalCapacity: 20,
    currentResidents: 10,
    medicalFacilities: {
      doctorVisits: true,
      nursingCare: true,
      emergencyCare: true,
      physiotherapy: false,
      other: false,
      otherDetails: '',
    },
    servicesOffered: {
      assistedLiving: true,
      independentLiving: false,
      dementiaCare: false,
      palliativeCare: false,
      homeHospital: false,
      dayCareServices: false,
      meals: false,
      recreationalActivities: false,
      other: false,
      otherDetails: '',
    },
    facilityPricing: { assistedLiving: { from: 1000, to: 2000 } },
  },
  poc_admin: {
    registrationNumber: 'REG-1',
    contactPersonName: 'Test Person',
    designation: 'Director',
    mobileNumber: '9999999999',
    emailAddress: 'test@example.com',
    commercialAgreed: true,
    declarationAgreed: true,
    ownerName: 'Owner',
    ownerPhone: '8888888888',
    ownerEmail: 'owner@example.com',
  },
};

function multipartApp() {
  const app = express();
  app.post('/enroll', enrollmentMultipart, (req, res, next) => {
    try {
      const data = enrollmentMultipartBodySchema.parse(req.body);
      res.json({
        data,
        fields: Object.fromEntries(
          Object.entries(req.files).map(([k, v]) => [k, v.length]),
        ),
      });
    } catch (error) {
      next(error);
    }
  });
  app.use((error, _req, res, _next) =>
    res.status(error.status || 422).json({ error: error.message }),
  );
  return app;
}

async function withServer(run) {
  const server = multipartApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await run(server);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('enrollment route contracts keep JSON and add one safe multipart create endpoint', () => {
  assert.deepEqual(
    appEnrollmentsRoutes.map(({ method, path }) => `${method.toUpperCase()} ${path}`),
    [
      'POST /upload-sessions',
      'POST /upload-sessions/files',
      'POST /upload-sessions/part-url',
      'POST /upload-sessions/complete',
      'DELETE /upload-sessions/file',
      'POST /with-uploaded-files',
      'POST /with-files',
      'POST /',
    ],
  );
  assert.deepEqual(
    enrollmentsRoutes.map(({ method, path }) => `${method.toUpperCase()} ${path}`),
    [
      'PUT /:id/media',
      'GET /',
      'GET /:id',
      'PATCH /:id/status',
      'PUT /:id',
      'DELETE /:id',
      'POST /:id/restore',
    ],
  );
  assert.equal(enrollmentBodySchema.safeParse(payload).success, false);
  assert.equal(enrollmentMultipartBodySchema.safeParse(payload).success, true);
  assert.equal(
    enrollmentMediaUpdateSchema.safeParse({ clearFields: ['facilityVideo'] }).success,
    true,
  );
  assert.equal(enrollmentMediaUpdateSchema.safeParse({}).success, false);
});

test('multipart enrollment accepts named images, documents, MP4 and required fields', async () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');
  const mp4 = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from('ftypmp42'),
    Buffer.alloc(12),
  ]);
  const response = await withServer((server) =>
    request(server)
      .post('/enroll')
      .field('payload', JSON.stringify(payload))
      .attach('facilityPhotographs', png, {
        filename: 'home.png',
        contentType: 'image/png',
      })
      .attach('facilityVideo', mp4, {
        filename: 'tour.mp4',
        contentType: 'video/mp4',
      })
      .attach('registrationCertificate', pdf, {
        filename: 'registration.pdf',
        contentType: 'application/pdf',
      })
      .attach('panCard', png, { filename: 'pan.png', contentType: 'image/png' })
      .attach('addressProof', pdf, {
        filename: 'address.pdf',
        contentType: 'application/pdf',
      })
      .attach('representativeIdProof', png, {
        filename: 'id.png',
        contentType: 'image/png',
      })
      .attach('bankAccountDetails', pdf, {
        filename: 'bank.pdf',
        contentType: 'application/pdf',
      })
      .attach('digitalSignature', png, {
        filename: 'signature.png',
        contentType: 'image/png',
      }),
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.fields.facilityPhotographs, 1);
  assert.equal(response.body.fields.digitalSignature, 1);
});

test('multipart enrollment rejects MIME spoofing and malformed JSON', async () => {
  const spoofed = await withServer((server) =>
    request(server)
      .post('/enroll')
      .field('payload', JSON.stringify(payload))
      .attach('panCard', Buffer.from('not an image'), {
        filename: 'pan.png',
        contentType: 'image/png',
      }),
  );
  assert.equal(spoofed.status, 400);
  const malformed = await withServer((server) =>
    request(server).post('/enroll').field('payload', '{'),
  );
  assert.equal(malformed.status, 400);
});

test('digital signature is flattened and stored as a real JPEG', async () => {
  const result = await signatureAsJpeg({ buffer: png });
  assert.equal(result.mimetype, 'image/jpeg');
  assert.equal(result.buffer[0], 0xff);
  assert.equal(result.buffer[1], 0xd8);
  assert.equal(result.buffer.at(-2), 0xff);
  assert.equal(result.buffer.at(-1), 0xd9);
});

test('chunk protocol creates a shared session and supports large sequential video parts', async () => {
  const response = () => {
    const state = { statusCode: 200 };
    return {
      state,
      status(code) {
        state.statusCode = code;
        return this;
      },
      json(body) {
        state.body = body;
        return this;
      },
    };
  };
  const sessionResponse = response();
  await createEnrollmentUploadSession({}, sessionResponse);
  assert.equal(sessionResponse.state.statusCode, 201);
  assert.equal(sessionResponse.state.body.chunkSize, 8 * 1024 * 1024);

  const originalSend = s3.send;
  s3.send = async (command) => {
    assert.equal(command.constructor.name, 'CreateMultipartUploadCommand');
    return { UploadId: 'test-upload-id' };
  };
  try {
    const initiateResponse = response();
    await initiateEnrollmentFile(
      {
        validated: {
          sessionToken: sessionResponse.state.body.sessionToken,
          field: 'facilityVideo',
          fileName: 'tour.mp4',
          contentType: 'video/mp4',
          size: 100 * 1024 * 1024,
        },
      },
      initiateResponse,
    );
    assert.equal(initiateResponse.state.statusCode, 201);
    assert.equal(
      initiateResponse.state.body.partCount,
      Math.ceil((100 * 1024 * 1024) / ENROLLMENT_CHUNK_BYTES),
    );
    assert.ok(initiateResponse.state.body.fileToken);
  } finally {
    s3.send = originalSend;
  }
});
