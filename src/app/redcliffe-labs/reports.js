import { createHash, randomUUID } from 'node:crypto';
import { recordProviderCall } from '../../shared/provider-log.js';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';
export function reportUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      (u.hostname === 'redcliffelabsbackend.s3.amazonaws.com' ||
        u.hostname === 'staticlims.s3.amazonaws.com' ||
        u.hostname === 'redcliffelabsbackend.s3.ap-south-1.amazonaws.com' ||
        u.hostname === 'redcliffelabs.com' ||
        u.hostname.endsWith('.redcliffelabs.com'))
      ? u.href
      : null;
  } catch {
    return null;
  }
}
export function reportsFromBooking(remote) {
  const entries = Array.isArray(remote?.report) ? [...remote.report] : [];
  if (Array.isArray(remote?.booking_report)) entries.push(...remote.booking_report);
  for (const value of [
    remote?.report_link,
    remote?.Report_url,
    remote?.report_url,
    typeof remote?.report === 'string' ? remote.report : null,
    typeof remote?.booking_report === 'string' ? remote.booking_report : null,
  ])
    if (value) entries.push({ report_link: value });
  const validEntries = entries.filter(item => reportUrl(typeof item === 'string' ? item : item?.report_link || item?.report));
  const reportId = item => /^\d+$/.test(String(item?.id ?? '')) ? BigInt(item.id) : -1n;
  validEntries.sort((a, b) => reportId(a) > reportId(b) ? -1 : reportId(a) < reportId(b) ? 1 : 0);
  return validEntries.slice(0, 1).flatMap((item) => {
    const url = reportUrl(typeof item === 'string' ? item : item?.report_link || item?.report);
    return url
      ? [
          {
            id: createHash('sha256').update(url).digest('hex').slice(0, 24),
            url,
            label: (item.status || item.report_status) === 'partial' ? 'Partial report' : 'Lab report',
            patientId: String(item.patient_id || ''),
          },
        ]
      : [];
  });
}
export async function downloadReport(req, res) {
  const [row] = await sequelize.query(
    'SELECT payload FROM lab_bookings WHERE id=:id AND customer_id=:customer',
    {
      replacements: { id: req.validatedParams.id, customer: req.credential.id },
      type: QueryTypes.SELECT,
    },
  );
  const report = row?.payload?.reports?.find(
    (item) => item.id === req.validatedParams.reportId,
  );
  const url = reportUrl(report?.url);
  if (!url) throw new HttpError(404, 'Report is not available. Refresh My Orders.');
  const started = Date.now();
  const log = {
    provider: 'redcliffe',
    providerRequestId: randomUUID(),
    endpoint: '/report-download',
    method: 'GET',
  };
  let response;
  try {
    response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    await recordProviderCall({
      ...log,
      httpStatus: response.status,
      durationMs: Date.now() - started,
    });
  } catch {
    await recordProviderCall({
      ...log,
      failure: 'download_failed',
      durationMs: Date.now() - started,
    });
    throw new HttpError(502, 'Could not download the report. Please retry.');
  }
  if (!response.ok)
    throw new HttpError(
      502,
      'Report link is unavailable. Refresh My Orders and try again.',
    );
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 20 * 1024 * 1024)
      throw new HttpError(502, 'Report exceeds the download size limit.');
    chunks.push(chunk);
  }
  const pdf = Buffer.concat(chunks);
  if (!pdf.subarray(0, 1024).includes(Buffer.from('%PDF-')))
    throw new HttpError(502, 'The lab has not returned a valid PDF report.');
  res
    .set('Cache-Control', 'no-store')
    .json({
      filename: `Merabetta-report-${report.id}.pdf`,
      base64: pdf.toString('base64'),
    });
}
