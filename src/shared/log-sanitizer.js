const sensitiveKey =
  /password|token|secret|authorization|cookie|otp|^code$|devcode|codehash/i;

export function sanitizeLogValue(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (value == null) return value;
  if (typeof value === 'object' && typeof value.toJSON === 'function') {
    try {
      value = value.toJSON();
    } catch {
      // ignore
    }
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeLogValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).slice(0, 50).map(([key, item]) => [
        key,
        sensitiveKey.test(key) ? '[REDACTED]' : sanitizeLogValue(item, depth + 1),
      ]),
    );
  }
  if (typeof value === 'string') return value.slice(0, 2000);
  return value;
}

export function sanitizeSql(sql) {
  // SQL can contain inline credentials/contact values even when bind logging is off.
  return sql.replace(/'(?:''|\\.|[^'\\])*'/g, "'[VALUE]'").slice(0, 12000);
}
