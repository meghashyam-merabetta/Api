export const collectionSlots = [
  { id: '07-09', label: '7–9 AM', hour: 7 },
  { id: '09-11', label: '9–11 AM', hour: 9 },
  { id: '11-13', label: '11 AM–1 PM', hour: 11 },
  { id: '14-16', label: '2–4 PM', hour: 14 },
];
export function collectionDays(now = new Date()) {
  const today = new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(Date.parse(today + 'T00:00:00Z') + index * 86400000)
      .toISOString()
      .slice(0, 10);
    return {
      date,
      slots: collectionSlots.map((slot) => ({
        id: slot.id,
        label: slot.label,
        available:
          Date.parse(`${date}T${String(slot.hour).padStart(2, '0')}:00:00+05:30`) >
          now.getTime(),
      })),
    };
  });
}
export function selectedCollectionSlot(date, slotId, now = new Date()) {
  return collectionDays(now)
    .find((day) => day.date === date)
    ?.slots.find((slot) => slot.id === slotId && slot.available);
}
