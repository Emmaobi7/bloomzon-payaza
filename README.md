# Bloomzon Payaza Service

A dedicated microservice for handling Payaza payment integrations in the Bloomzon ecosystem.

## Features

- Payment initialization through Payaza API.
- Explicit payment verification endpoint.
- Webhook support with optional signature validation.
- Idempotent transaction handling using `tx_ref`.
- Automated cart cleanup for successful orders.

## Environment Variables

Create a `.env` file in this project root:

```env
PORT=5001
DB_HOST=your_db_host
DB_NAME=your_db_name
DB_USER=your_db_user
DB_PASSWORD=your_db_password

PAYAZA_PUBLIC_KEY=your_payaza_public_key
PAYAZA_SECRET_KEY=your_payaza_secret_key
PAYAZA_WEBHOOK_SECRET=your_payaza_webhook_secret

# You can override these if Payaza endpoints differ.
PAYAZA_BASE_URL=https://api.payaza.africa/live
PAYAZA_INITIALIZE_PATH=/payment/initialize
PAYAZA_VERIFY_PATH=/payment/verify

ORDER_URL=http://localhost:8080/api/order
CART_URL=http://localhost:8080/api/cart
```

## Run

```bash
npm install
npm run dev
```

## Endpoints

- `GET /health`
- `POST /api/payaza/initialize`
- `POST /api/payaza/verify`
- `POST /api/payaza/webhook`

## Notes

- This service is scaffolded to match the existing Flutterwave flow.
- Payaza endpoint paths and response keys may vary by account/product. The service exposes endpoint path env vars so you can adjust quickly without code changes.
# bloomzon-payaza
