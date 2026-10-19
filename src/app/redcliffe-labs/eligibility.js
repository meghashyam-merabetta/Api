export function editableBooking(remote) {
  return (
    !remote?.phlebo &&
    ['pending', 'booking pending', 'confirmation pending', 'order booked', 'confirmed', 'booking confirmed'].includes(
      String(remote?.booking_status?.value || remote?.booking_status || '')
        .trim()
        .toLowerCase(),
    )
  );
}
