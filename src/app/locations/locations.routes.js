import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { env } from '../../config/env.js';
import { HttpError } from '../../shared/errors.js';
import { randomUUID } from 'node:crypto';
import { recordProviderCall } from '../../shared/provider-log.js';

const limit = rateLimit({
  windowMs: 60000,
  limit: 90,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});
const coordinates = {
  lat: z.coerce.number().min(-85).max(85),
  lon: z.coerce.number().min(-180).max(180),
};

export function normalizeLocation(place) {
  const address = Object.fromEntries(
    Object.entries(place.address || {}).filter(([, value]) => typeof value === 'string'),
  );
  return {
    provider: 'locationiq',
    placeId: String(place.place_id || ''),
    displayName:
      place.display_name ||
      [place.display_place, place.display_address].filter(Boolean).join(', '),
    latitude: Number(place.lat),
    longitude: Number(place.lon),
    address,
    city:
      address.city ||
      address.town ||
      address.village ||
      address.municipality ||
      address.locality ||
      address.county ||
      '',
    state: address.state || '',
    postalCode: address.postcode || '',
  };
}

async function locationRequest(endpoint, params) {
  if (!env.LOCATIONIQ_API_KEY)
    throw new HttpError(
      503,
      'Address search is not configured yet. Please try again later.',
    );
  const url = new URL(endpoint);
  url.search = new URLSearchParams({ ...params, key: env.LOCATIONIQ_API_KEY }).toString();
  let response;
  const started = Date.now();
  const context = {
    providerRequestId: randomUUID(),
    provider: 'locationiq',
    endpoint: url.pathname,
    method: 'GET',
  };
  await recordProviderCall(context);
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    await recordProviderCall({
      ...context,
      httpStatus: response.status,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    await recordProviderCall({
      ...context,
      durationMs: Date.now() - started,
      failure: error?.name === 'TimeoutError' ? 'timeout' : 'network_error',
    });
    throw new HttpError(502, 'Location search could not be reached. Please retry.');
  }
  if (response.status === 404) return null;
  if (!response.ok)
    throw new HttpError(
      response.status === 429 ? 429 : 502,
      'Location service is temporarily unavailable. Please retry shortly.',
    );
  return response;
}

export const locationRoutes = [
  {
    method: 'get',
    path: '/search',
    auth: false,
    middleware: [limit],
    query: z.object({ q: z.string().trim().min(3).max(200) }).strict(),
    handler: async (req, res) => {
      const response = await locationRequest(
        'https://api.locationiq.com/v1/autocomplete',
        {
          q: req.validatedQuery.q,
          countrycodes: 'in',
          normalizecity: '1',
          limit: '5',
          'accept-language': 'en',
        },
      );
      const results = response ? await response.json() : [];
      res.json({ data: results.map(normalizeLocation) });
    },
  },
  {
    method: 'get',
    path: '/reverse',
    auth: false,
    middleware: [limit],
    query: z.object(coordinates).strict(),
    handler: async (req, res) => {
      const { lat, lon } = req.validatedQuery;
      const response = await locationRequest('https://us1.locationiq.com/v1/reverse', {
        lat: String(lat),
        lon: String(lon),
        format: 'json',
        addressdetails: '1',
        normalizeaddress: '1',
        'accept-language': 'en',
      });
      if (!response)
        throw new HttpError(
          422,
          'No address found here. Move the pin closer to a road or search another location.',
        );
      const location = normalizeLocation(await response.json());
      if (location.address.country_code !== 'in')
        throw new HttpError(422, 'Please choose an address in India.');
      // Preserve the exact collection pin, rather than the nearest reverse-geocoded feature.
      res.json({ ...location, latitude: lat, longitude: lon });
    },
  },
  {
    method: 'get',
    path: '/map',
    auth: false,
    middleware: [limit],
    query: z
      .object({ ...coordinates, zoom: z.coerce.number().int().min(10).max(18) })
      .strict(),
    handler: async (req, res) => {
      const { lat, lon, zoom } = req.validatedQuery;
      const response = await locationRequest('https://maps.locationiq.com/v3/staticmap', {
        center: `${lat},${lon}`,
        zoom: String(zoom),
        size: '600x400',
        format: 'png',
        maptype: 'streets',
      });
      if (!response || !response.headers.get('content-type')?.startsWith('image/'))
        throw new HttpError(502, 'Map could not be loaded. Please retry.');
      const data = Buffer.from(await response.arrayBuffer()).toString('base64');
      res.json({ uri: `data:image/png;base64,${data}` });
    },
  },
];
