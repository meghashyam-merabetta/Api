import { networkInterfaces } from 'node:os';
import { env } from './env.js';

// Trust only this development computer, not every host on the local network.
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
for (const addresses of Object.values(networkInterfaces())) {
  for (const address of addresses || []) {
    if (address.family === 'IPv4') localHosts.add(address.address);
  }
}

const expoPorts = new Set([
  '8081',
  '8082',
  '8083',
  '8084',
  '8085',
  '8086',
  '8087',
  '8088',
  '8089',
  '19006',
]);


export function isTrustedOrigin(origin, path = '') {
  if (!origin || origin === 'null') return false;

  // Explicit wildcard in ALLOWED_ORIGINS allows all browser origins.
  if (env.ALLOWED_ORIGINS.includes('*')) return true;

  if (env.ALLOWED_ORIGINS.includes(origin)) return true;

  if (env.NODE_ENV !== 'development' || !path.startsWith('/api/app/')) {
    return false;
  }

  try {
    const url = new URL(origin);

    return (
      url.origin === origin &&
      url.protocol === 'http:' &&
      localHosts.has(url.hostname) &&
      expoPorts.has(url.port)
    );
  } catch {
    return false;
  }
}
