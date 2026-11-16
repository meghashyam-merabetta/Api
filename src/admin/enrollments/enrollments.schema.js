import { z } from 'zod';

// 1. Validate :id in URL params (e.g. /api/admin/enrollments/:id)
export const enrollmentIdParamsSchema = z.object({
  id: z.uuid(),
});

// 2. Validate GET /api/admin/enrollments query params
export const listEnrollmentsQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  deleted: z.enum(['true', 'false']).default('false'),
  q: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(30).default(10),
  cursor: z.string().optional(),
});

// 3. Validate PATCH /api/admin/enrollments/:id/status body
export const updateEnrollmentStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE']),
});

// 4. Shared helpers for poc_client & poc_admin
const nonEmptyText = (max = 200) => z.string().trim().min(1).max(max);
const phone10 = z.string().trim().regex(/^\d{10}$/, 'Must be exactly 10 digits');
const pinCode6 = z.string().trim().regex(/^\d{6}$/, 'Must be exactly 6 digits');

const httpUrl = z
  .url()
  .refine((u) => /^https?:\/\//.test(u), 'Must be an http or https URL');

const medicalFacilitiesSchema = z
  .object({
    doctorVisits: z.boolean(),
    nursingCare: z.boolean(),
    emergencyCare: z.boolean(),
    physiotherapy: z.boolean(),
    other: z.boolean(),
    otherDetails: z.string().trim().default(''),
  })
  .superRefine((val, ctx) => {
    if (val.other && !val.otherDetails) {
      ctx.addIssue({
        code: 'custom',
        path: ['otherDetails'],
        message: 'otherDetails is required when other is true',
      });
    }
  });

const servicesOfferedSchema = z
  .object({
    assistedLiving: z.boolean(),
    independentLiving: z.boolean(),
    dementiaCare: z.boolean(),
    palliativeCare: z.boolean(),
    homeHospital: z.boolean(),
    dayCareServices: z.boolean(),
    meals: z.boolean(),
    recreationalActivities: z.boolean(),
    other: z.boolean(),
    otherDetails: z.string().trim().default(''),
  })
  .superRefine((val, ctx) => {
    if (val.other && !val.otherDetails) {
      ctx.addIssue({
        code: 'custom',
        path: ['otherDetails'],
        message: 'otherDetails is required when other is true',
      });
    }
  });

const pricingRangeSchema = z
  .object({
    from: z.coerce.number().nonnegative(),
    to: z.coerce.number().nonnegative(),
  })
  .refine((v) => v.to >= v.from, {
    message: 'to must be greater than or equal to from',
    path: ['to'],
  });

// 5. Validate PUT /api/admin/enrollments/:id body (and POST /enrollments later)
export const enrollmentBodySchema = z.object({
  poc_client: z
    .object({
      homeName: nonEmptyText(200),
      yearEstablished: z.coerce.number().int().min(1800).max(new Date().getFullYear()),
      organizationType: z.enum(['Government', 'Private', 'Trust/NGO', 'Other']),
      address: nonEmptyText(500),
      city: nonEmptyText(200),
      state: nonEmptyText(200),
      pinCode: pinCode6,
      website: z.union([z.literal(''), httpUrl]).optional(),
      totalCapacity: z.coerce.number().int().nonnegative(),
      currentResidents: z.coerce.number().int().nonnegative(),
      medicalFacilities: medicalFacilitiesSchema,
      servicesOffered: servicesOfferedSchema,
      facilityPricing: z.record(z.string(), pricingRangeSchema),
      facilityPhotographs: z.array(nonEmptyText(1000)).max(10),
      facilityVideo: nonEmptyText(1000).nullable().optional(),
    })
    .superRefine((val, ctx) => {
      for (const [service, enabled] of Object.entries(val.servicesOffered)) {
        if (service !== 'otherDetails' && enabled === true && !val.facilityPricing[service]) {
          ctx.addIssue({
            code: 'custom',
            path: ['facilityPricing', service],
            message: `Pricing is required for selected service: ${service}`,
          });
        }
      }
    }),

  poc_admin: z.object({
    registrationNumber: nonEmptyText(200),
    contactPersonName: nonEmptyText(200),
    designation: nonEmptyText(200),
    mobileNumber: phone10,
    emailAddress: z.email(),
    registrationCertificate: nonEmptyText(1000),
    panCard: nonEmptyText(1000),
    gstCertificate: nonEmptyText(1000).nullable().optional(),
    addressProof: nonEmptyText(1000),
    representativeIdProof: nonEmptyText(1000),
    bankAccountDetails: nonEmptyText(1000),
    licensesCertificates: z.array(nonEmptyText(1000)).optional(),
    commercialAgreed: z.literal(true),
    declarationAgreed: z.literal(true),
    ownerName: nonEmptyText(200),
    ownerPhone: phone10,
    ownerEmail: z.email(),
    digitalSignature: nonEmptyText(1000),
  }),
});
