# STPL login OTP

Fill API/.env:
```
OTP_MODE=stpl
STPL_BASE_URL=https://YOUR-STPL-HOST
STPL_USERNAME=
STPL_PASSWORD=
STPL_SENDER_ID=
STPL_TEMPLATE_ID=
STPL_DLT_CONTENT_ID=
STPL_OTP_TEMPLATE="Your exact approved message with {otp} in place of the code"
STPL_UNICODE=false
```
Use the exact approved SMS text, including punctuation and spaces. Sender ID must be the exact approved six-character alphanumeric header. The supplied document specifies letters; approved headers containing digits are passed unchanged and STPL remains authoritative for acceptance. This implementation requires the HTTPS endpoint; obtain it from STPL. No guessed production domain is used. STPL_BASE_URL is the host; /sms-api/v2/send/ is appended automatically.

Restart the API after configuration. Existing OTP_MODE is not automatically changed while credentials are incomplete. STPL sends mobile OTP only. Email delivery is not configured. Existing 10-minute expiry, 30-second resend delay and five verification attempts remain in effect. OTP is generated and verified on our backend; STPL delivers the SMS using URL-encoded POST fields documented in the supplied HTTP API.

Only SUBMIT_ACCEPTED with a transaction ID is accepted. It means gateway submission, not handset delivery. Failed/uncertain sends invalidate that challenge; no automatic SMS resend occurs. Responses never contain devCode in STPL mode. OTP bodies and credentials are not logged. third_party_api_logs contains metadata; customer_otp_challenges.delivery_response stores transactionId, state and pdu for delivery troubleshooting. Delivery callbacks are not enabled because the supplied callback format has no authentication specification.

Run migration 015-stpl-otp.sql before using the service. Test with node --test --experimental-test-isolation=none scripts/stpl.test.js. No real SMS is sent by this test.

The approved Merabetta template supports {#num#} for OTP and {#alp#}, currently filled as Customer for both new and returning logins. Preserve the blank line before Team Vision55.
