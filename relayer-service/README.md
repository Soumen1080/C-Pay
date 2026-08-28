# C-Pay Stellar Relayer

Backend service that sponsors Stellar account setup, submits fee-bump payments, and handles test Add Money distribution.

## Setup

```bash
npm install
cp .env.example .env
npm start
```

## Required Environment

- `STELLAR_NETWORK`: `testnet` or `public`
- `STELLAR_HORIZON_URL`: Horizon endpoint
- `STELLAR_NETWORK_PASSPHRASE`: network passphrase
- `CPINR_ASSET_CODE`: `CPINR`
- `CPINR_ASSET_ISSUER`: issuer public key from blockchain setup
- `SPONSOR_SECRET`: secret seed for the account that sponsors reserves and pays fees
- `DISTRIBUTION_SECRET`: secret seed for the hot distribution account
- `RELAYER_AUTH_REQUIRED`: set to `true` for production/public-network deployments
- `SUPABASE_JWT_SECRET`: required for legacy HS256 Supabase JWT verification when relayer auth is enabled, unless using Supabase Auth API validation with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_URL`: optional; enables persistent Add Money claim logging/cooldowns
- `SUPABASE_SERVICE_ROLE_KEY`: optional; required with `SUPABASE_URL` for relayer-only writes to `add_money_claims`
- `ENABLE_ADD_MONEY`: defaults off on `public`; keep off for real-money production

Keep issuer secrets offline. The relayer needs sponsor and capped distribution secrets for Stellar payments.

## Endpoints

- `GET /health`
- `GET /account/:accountId/status`
- `GET /account/:accountId/balance`
- `POST /accounts/prepare`
- `POST /accounts/submit`
- `POST /payments/submit`
- `POST /add-money`
- `GET /tx/:hash`

## Production Notes

- Put the relayer behind HTTPS.
- Restrict `CORS_ORIGIN` to app domains/builds.
- Enable `RELAYER_AUTH_REQUIRED=true` and configure Supabase token verification so only authenticated app users can spend sponsored relayer resources.
- Leave `ENABLE_ADD_MONEY=false` on public network unless you intentionally operate a funded, abuse-resistant promotion flow.
- Rotate `SPONSOR_SECRET` and `DISTRIBUTION_SECRET` through infrastructure secrets.
- Keep `ADD_MONEY_AMOUNT`, `MAX_PAYMENT_AMOUNT`, and `ADD_MONEY_COOLDOWN_MS` policy controlled.
- Configure `ALERT_WEBHOOK_URL` for low XLM or low CPINR inventory alerts.
