const hiddenKey = /(?:password|secret|token|api.?key|authorization|cookie|private.?key|public.?key|encrypted|signature|sdk.?payload|payment.?links?|payment.?url|return.?url|customer|email|phone|mobile|name|address|card|cvv|cvc|upi|vpa|account|bank.?reference|auth|headers?)/i;
const limit = 4096;
function cleanText(value) {
  return value.slice(0, limit)
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/\b(?:\+?\d[\d\s-]{8,}\d)\b/g, '[REDACTED_NUMBER]')
    .replace(/\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_JWT]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(password|secret|token|api[_ -]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}
export function safeGatewayValue(value, depth = 0) {
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') return cleanText(value);
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => safeGatewayValue(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, hiddenKey.test(key) ? '[REDACTED]' : safeGatewayValue(item, depth + 1)]));
  return '[UNSUPPORTED]';
}
export function safeGatewayResponse(text) {
  if (typeof text !== 'string') return null;
  try { return safeGatewayValue(JSON.parse(text)); }
  catch { return { non_json: true, text: cleanText(text) }; }
}
export function safeGatewayRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  return safeGatewayValue(body);
}
