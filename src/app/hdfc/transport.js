import https from 'node:https';

// JWT session/status requests use POST with an encrypted JSON body.
// Basic-auth status uses GET without a body. Never follow redirects with credentials.
export const gatewayTransport = {
  request(url, { method, headers, body, timeoutMs = 12000 }) {
    return new Promise((resolve, reject) => {
      const request = https.request(url, {
        method,
        headers: { ...headers, ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
      }, response => {
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) {
            request.destroy(new Error('Gateway response too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', reject);
      request.end(body);
    });
  },
};
