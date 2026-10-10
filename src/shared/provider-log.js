import { sequelize } from '../config/database.js';
import { logger } from '../config/logger.js';

// Persist only explicit diagnostic fields: never request bodies, query strings,
// headers, raw provider responses, patient details or credentials.
export async function recordProviderCall(event) {
  try {
    await sequelize.query(
      `INSERT INTO third_party_api_logs
      (id,provider,endpoint,method,outcome,http_status,duration_ms,provider_status,validation_fields,failure)
      VALUES (:id,:provider,:endpoint,:method,:outcome,:httpStatus,:duration,:providerStatus,CAST(:fields AS jsonb),:failure)
      ON CONFLICT(id) DO UPDATE SET outcome=EXCLUDED.outcome,
      http_status=COALESCE(EXCLUDED.http_status,third_party_api_logs.http_status),
      duration_ms=EXCLUDED.duration_ms,
      provider_status=COALESCE(EXCLUDED.provider_status,third_party_api_logs.provider_status),
      validation_fields=CASE WHEN EXCLUDED.validation_fields='[]'::jsonb THEN third_party_api_logs.validation_fields ELSE EXCLUDED.validation_fields END,
      failure=EXCLUDED.failure,updated_at=now()`,
      {
        replacements: {
          id: event.providerRequestId,
          provider: event.provider,
          endpoint: event.endpoint.split('?')[0],
          method: event.method,
          outcome: event.failure
            ? 'failed'
            : event.httpStatus
              ? event.httpStatus >= 400 ||
                /failed|failure/i.test(event.providerStatus || '')
                ? 'failed'
                : 'received'
              : 'started',
          httpStatus: event.httpStatus ?? null,
          duration: event.durationMs ?? null,
          providerStatus: event.providerStatus ?? null,
          fields: JSON.stringify(event.validationFields || []),
          failure: event.failure ?? null,
        },
        logging: false,
      },
    );
  } catch {
    // Logging failure must not turn an accepted provider booking into a failed booking.
    logger.error(
      { provider: event.provider, providerRequestId: event.providerRequestId },
      'Could not persist third-party API log',
    );
  }
}
