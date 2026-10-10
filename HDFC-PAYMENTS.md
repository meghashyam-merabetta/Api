# HDFC SmartGateway product payments

Implemented using the supplied Basic Auth Session API, server-side Order Status API and authenticated webhooks. Hosted checkout avoids collecting card/UPI credentials in Merabetta.

## Configuration
Set API/.env:
- HDFC_ENVIRONMENT=sandbox (switch to production only with approved live credentials)
- HDFC_MERCHANT_ID: bank merchant ID
- HDFC_API_KEY: raw API key; the backend encodes it as documented
- HDFC_CLIENT_ID=hdfcmaster for sandbox; bank merchant/client ID for production
- HDFC_RETURN_URL=https://YOUR-API-DOMAIN/api/payments/hdfc/return
- HDFC_WEBHOOK_USER and HDFC_WEBHOOK_PASSWORD: credentials configured identically in the bank dashboard

Configure https://YOUR-API-DOMAIN/api/payments/hdfc/webhook in the bank dashboard. Enable relevant order/transaction payment events. Return URL must be public HTTPS, without query parameters. Restart the backend after changing env.

## Data and behavior
014-product-orders.sql creates orders, order_details, product_catalog. Migration seeds existing application products without overwriting existing DB prices. Review these catalog prices before enabling live payments. Checkout uses DB prices and the existing MERA20 discount/delivery rules; client amounts are never trusted.

POST /api/app/orders saves the order and item snapshots before contacting HDFC. A request key and customer lock protect retries. Identical unpaid checkout details reuse the saved order, even with a new request key. An ambiguous session submission is not blindly retried: use Check payment status to recover the bank payment link or contact support if unavailable.

GET /api/app/orders lists owned orders. GET /api/app/orders/:id verifies bank status. Only verified CHARGED with matching merchant, order, INR and amount is paid. Pending/failed statuses do not clear the cart. Paid state cannot regress on delayed notifications. The callback page never trusts browser parameters; the app and authenticated webhook query HDFC directly.

Each item is persisted in order_details with quantity, unit price and immutable product snapshot. Third-party metadata goes into third_party_api_logs. No card data, API keys, full bank responses or payment links are logged.

The app opens HDFC checkout externally, then supports Check payment status and foreground refresh. Webhooks update payments even when the app is closed. No refund or product cancellation flow is implemented; real orders cannot use the old demo cancel action.

## Verification
npm run lint
node scripts/check-product-payments.js
App: npm run typecheck

The integration test creates and cleans temporary DB customer/order rows and mocks all bank HTTP calls. It makes no real payment.

Reference documentation:
https://docs.hdfcbank.juspay.in/docs/smartgateway-api-ref-basicauth/docs/apis/session
https://docs.hdfcbank.juspay.in/docs/smartgateway-api-ref-basicauth/docs/apis/order-status-api
https://docs.hdfcbank.juspay.in/docs/smartgateway-api-ref-basicauth/docs/handling-payment-response/webhooks
