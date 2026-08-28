# C-Pay Stellar Blockchain Setup

This folder owns the Stellar asset setup and payment rail helpers used by C-Pay.

The design is:

- `CPINR` is the Stellar issued asset for INR-denominated C-Pay balances.
- The app never stores issuer or distribution secrets.
- The relayer verifies Stellar payments and sponsors account/trustline creation.

## Folder Layout

```text
Blockchain/
  scripts/create-keypairs.js Generates Stellar keypairs for setup
  scripts/setup-testnet-asset.js Issues CPINR on Stellar testnet
  src/config.js              Shared Stellar config helpers
  src/stellarRail.js         Transaction helper functions
  test/stellarRail.test.js   JavaScript helper tests
```

## Accounts

`ASSET_ISSUER` creates the `CPINR` asset. Keep this account cold, use multisig for production, and never use it from the mobile app or hot backend payment flow.

`ASSET_DISTRIBUTION` receives the issued `CPINR` supply and handles operational distribution. Keep only the amount needed for operations in this account.

## Required Tools

- Node.js 18 or newer
- npm

## Environment Variables

Create `Blockchain/.env` from `.env.example`.

| Variable | Purpose |
| --- | --- |
| `STELLAR_NETWORK` | `testnet` for test setup, `public` for production |
| `STELLAR_HORIZON_URL` | Horizon endpoint for classic Stellar payments |
| `STELLAR_NETWORK_PASSPHRASE` | Network passphrase used for transaction XDR |
| `STELLAR_BASE_FEE` | Classic Stellar base fee in stroops |
| `ASSET_CODE` | Asset code, currently `CPINR` |
| `ASSET_ISSUER_PUBLIC_KEY` | Public key of the issuer account |
| `ASSET_DISTRIBUTION_PUBLIC_KEY` | Public key of the distribution account |
| `ASSET_ISSUER_SECRET` | Testnet setup only; do not keep online in production |
| `ASSET_DISTRIBUTION_SECRET` | Testnet setup only; backend-only if used operationally |
| `INITIAL_SUPPLY` | Testnet amount issued to distribution |
| `TRUSTLINE_LIMIT` | Distribution account trustline limit |
| `ASSET_HOME_DOMAIN` | Optional Stellar asset home domain |
| `LOCK_ISSUER_AFTER_SETUP` | `true` disables further testnet issuance after setup |

## Generate Keys

For local testnet setup:

```bash
npm run create:keypairs
```

The script prints:

- `ASSET_ISSUER_PUBLIC_KEY` and `ASSET_ISSUER_SECRET`
- `ASSET_DISTRIBUTION_PUBLIC_KEY` and `ASSET_DISTRIBUTION_SECRET`

For production, generate the issuer and distribution accounts using your secure key-management process. Do not rely on printed terminal secrets for production custody.

## Testnet Asset Setup

Install dependencies in `Blockchain/`:

```bash
npm install
```

Set these `.env` values first:

```text
STELLAR_NETWORK=testnet
ASSET_CODE=CPINR
ASSET_ISSUER_PUBLIC_KEY=<issuer public key>
ASSET_DISTRIBUTION_PUBLIC_KEY=<distribution public key>
ASSET_ISSUER_SECRET=<issuer secret>
ASSET_DISTRIBUTION_SECRET=<distribution secret>
INITIAL_SUPPLY=1000000000
TRUSTLINE_LIMIT=1000000000
```

Run:

```bash
npm run setup:testnet
```

This funds the issuer and distribution accounts on testnet, creates the distribution trustline, and sends the initial `CPINR` supply from issuer to distribution.

## Payment Flow

1. App requests sponsored account creation / trustline from relayer.
2. User or merchant shares wallet address / C-Pay ID / QR code.
3. App signs a Stellar `CPINR` payment transaction.
4. Relayer submits or fee-bumps the payment if the product flow requires sponsored fees.
5. Horizon confirms the transaction and app shows payment receipt.

Stellar account balances and Horizon payment records remain the payment source of truth.

## Production Rules

- Keep issuer secrets offline after asset setup.
- Use multisig for issuer account.
- Keep distribution balances capped by policy.
- Do not put any secret seed in the mobile app.
- Run JavaScript helper tests before deployment.

## Verification

Run JavaScript helper tests:

```bash
npm test
```
