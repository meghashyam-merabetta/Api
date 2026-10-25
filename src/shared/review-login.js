// Explicit server opt-in, scoped to one dedicated email account.
export function reviewOtpFor(method, contact, config) {
  return method === 'email' &&
    config.APP_REVIEW_EMAIL &&
    config.APP_REVIEW_OTP &&
    contact === config.APP_REVIEW_EMAIL.toLowerCase()
    ? config.APP_REVIEW_OTP
    : null;
}
