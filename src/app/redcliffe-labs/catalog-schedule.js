// Fixed IST slots: 04:00 and 16:00. UTC arithmetic avoids server timezone differences.
export function latestCatalogSlot(now = new Date()) {
  const offset = 330 * 60000;
  const local = new Date(now.getTime() + offset);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const hour = local.getUTCHours();
  return new Date(midnight + (hour >= 16 ? 16 : hour >= 4 ? 4 : -8) * 3600000 - offset);
}

export function catalogSyncDue(state, now = new Date()) {
  if (state.status === 'syncing' || state.status === 'retrying') return true;
  // Catch up the latest missed slot on startup, without replaying all missed slots.
  return !state.started_at || new Date(state.started_at) < latestCatalogSlot(now);
}
