import { HttpError } from '../../shared/errors.js';
import { paths, providerRequest, providerSucceeded, slotErrorMessage } from './client.js';

export function todayInIndia(now = new Date()) {
  return new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
}
export function collectionDates(now = new Date()) {
  return Array.from({ length: 5 }, (_, i) =>
    new Date(Date.parse(todayInIndia(now) + 'T00:00:00Z') + i * 86400000)
      .toISOString()
      .slice(0, 10),
  );
}
export function normalizeSlots(body, date, now = new Date()) {
  const serviceMessage = slotErrorMessage(body, '');
  if (
    body?.serviceable === false ||
    body?.is_serviceable === false ||
    /(?:non|not|un)[\s-]*service?able/i.test(serviceMessage)
  )
    return {
      serviceable: false,
      slots: [],
      message:
        'Redcliffe home collection is not available at this address. Please choose another address.',
    };
  if (!providerSucceeded(body)) {
    if (/non[- ]?serviceable|not serviceable|unserviceable/i.test(String(body?.message)))
      return {
        serviceable: false,
        slots: [],
        message:
          'Redcliffe home collection is not available at this address. Please choose another address.',
      };
    if (/no slots/i.test(String(body?.message)))
      return {
        serviceable: true,
        slots: [],
        message: 'No collection slots are available for this date.',
      };
    throw new HttpError(
      502,
      slotErrorMessage(
        body,
        'Collection availability could not be checked. Please retry.',
      ),
    );
  }
  const rows = body.results ?? body.data;
  if (!Array.isArray(rows))
    throw new HttpError(502, 'Redcliffe returned invalid slot data.');
  const slots = rows.map((row) => {
    const id = Number(row.id ?? row.slot_id);
    const start = row.format_24_hrs?.start_time;
    const end = row.format_24_hrs?.end_time;
    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      !/^\d{2}:\d{2}(:\d{2})?$/.test(start) ||
      !/^\d{2}:\d{2}(:\d{2})?$/.test(end)
    )
      throw new HttpError(502, 'Redcliffe returned invalid slot data.');
    return {
      id: String(id),
      startTime: start,
      label: `${row.format_12_hrs?.start_time || start} – ${row.format_12_hrs?.end_time || end}`,
      available:
        Number(row.available_slot) > 0 &&
        Date.parse(`${date}T${start}+05:30`) > now.getTime(),
    };
  });
  return {
    serviceable: true,
    slots,
    message: slots.some((slot) => slot.available)
      ? ''
      : 'No collection slots are available for this date.',
  };
}
export async function availableSlots(date, latitude, longitude) {
  if (!collectionDates().includes(date))
    throw new HttpError(422, 'Choose today or one of the next four days.');
  return normalizeSlots(
    await providerRequest(paths.slots, {
      query: {
        collection_date: date,
        latitude: String(latitude),
        longitude: String(longitude),
      },
    }).catch((error) => {
      if (/(?:non|not|un)[\s-]*service?able/i.test(error.message))
        return { status: 'failure', message: error.message };
      throw error;
    }),
    date,
  );
}
export async function slots(req, res) {
  const { collectionDate, latitude, longitude } = req.validatedQuery;
  res.json({
    ...(await availableSlots(collectionDate, latitude, longitude)),
    collectionDate,
    dates: collectionDates(),
    timeZone: 'Asia/Kolkata',
  });
}
