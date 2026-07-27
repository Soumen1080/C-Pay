# Contributing to C-Pay

Thanks for helping improve C-Pay. This repo contains a mobile app, a Stellar relayer, and Soroban contract code, so contributions should be careful about user safety, payment correctness, and clear UX.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.

## Project Areas

| Directory | Description |
| --- | --- |
| `App/` | Expo React Native mobile wallet and merchant app |
| `relayer-service/` | Express service for sponsored setup, payments, Add Money, and contract coordination |
| `Blockchain/` | Stellar asset scripts, Soroban contract, and blockchain helper tests |
| `public/` | Screenshots and demo assets used by documentation |

## Before You Start

1. **Open an issue first** for large changes. Small fixes (typos, obvious bugs) can go straight to a PR.
2. Keep changes scoped to one feature, bug, or refactor.
3. Do not commit real secrets, Stellar secret seeds, service-role keys, production `.env` files, or private user data.
4. Treat wallet, relayer, transaction, and contract changes as security-sensitive.

## Local Setup

### Prerequisites

- Node.js 18+
- Rust 1.84+ (for contract changes)
- Stellar CLI v25+ (for contract changes)
- A Supabase project (for mobile/relayer changes)

### Install Dependencies

```bash
cd App && npm install
cd ../relayer-service && npm install
cd ../Blockchain && npm install
```

### Environment Files

Copy the example env files and fill in your own values:

```bash
cp App/.env.example App/.env
cp relayer-service/.env.example relayer-service/.env
cp Blockchain/.env.example Blockchain/.env
```

**Never commit real `.env` files.** Use testnet values for local development. Never use production funds or production secret seeds in local files.

## Running Checks

Run only the checks relevant to your change:

### Mobile App

```bash
cd App
npx tsc --noEmit
npx expo install --check
```

### Relayer

```bash
cd relayer-service
node --check server.js
node --check test-relayer.js
npm test -- --passWithNoTests --runInBand
```

### Blockchain and Contract

```bash
cd Blockchain
npm test -- --runInBand
cargo fmt --manifest-path contracts/cpay_payments/Cargo.toml -- --check
cargo test --manifest-path contracts/cpay_payments/Cargo.toml
```

## Mobile UX Guidelines

- Keep screens simple, readable, and safe for payment decisions.
- Prefer reusable components from `App/src/components/` over one-off UI.
- Use the shared theme in `App/src/constants/theme.ts`.
- Make payment, recovery, export-key, and merchant actions explicit and hard to misread.
- Support small screens, large text, screen readers, and clear loading/error states.
- Avoid adding "coming soon" buttons unless the issue explicitly asks for a placeholder.

## Security Guidelines

- Never expose Stellar `S...` secret seeds in app code, docs, screenshots, logs, or examples.
- Keep Supabase service-role keys only in backend environments.
- Bind authenticated users to their own wallet and merchant records in backend changes.
- Do not trust client-written transaction status for balances, receipts, or merchant analytics.
- Add tests for payment validation, relayer authorization, and contract state transitions when changing those paths.

## Pull Request Process

1. Use the [PR template](.github/pull_request_template.md) when opening a pull request.
2. Describe the user problem and the implemented solution.
3. List the main files changed.
4. Include screenshots or short recordings for UI changes.
5. Include test output, or explain why tests were not run.
6. Note any migration, environment, or deployment steps.
7. Confirm no secrets or private user data were added.
8. A maintainer will review your PR. Small fixes may be merged quickly; larger changes require at least one approval.

## Documentation

Update documentation when a change affects setup, environment variables, contract IDs, public API endpoints, user flows, screenshots, or production notes. Keep public docs privacy-safe and avoid publishing real pilot user information.

## Getting Help

- **Issues**: Use GitHub [issues](https://github.com/soumen0818/C-Pay/issues) for bug reports and feature requests.
- **Discussions**: Use GitHub [discussions](https://github.com/soumen0818/C-Pay/discussions) for questions and general conversation.
- **Security**: See [SECURITY.md](SECURITY.md) for reporting vulnerabilities privately.
