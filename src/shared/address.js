export function formatAddress(address) {
  const parts = [
    address.line1,
    address.line2,
    address.landmark,
    address.location?.displayName,
    address.city,
    address.state,
    address.postalCode,
  ];
  const seen = new Set();
  return parts
    .filter(Boolean)
    .flatMap((part) => String(part).split(','))
    .map((part) => part.trim())
    .filter((part) => {
      const key = part.toLowerCase().replace(/\s+/g, ' ');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(', ');
}
