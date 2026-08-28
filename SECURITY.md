# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in C-Pay, please report it responsibly. **Do not open a public GitHub issue for security vulnerabilities.**

Instead, email the maintainers directly or use [GitHub's private vulnerability reporting](https://github.com/soumen0818/C-Pay/security/advisories/new).

Please include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You will receive an initial response within 72 hours. We will work with you to understand and address the issue before any public disclosure.

## Scope

C-Pay handles Stellar wallets, encrypted key storage, payment transactions, and merchant data. Security-sensitive areas include:

- **Wallet encryption** (`App/src/services/wallet.ts`, `App/src/services/cloudWalletBackup.ts`) -- Stellar secret storage and cloud backup encryption
- **Relayer** (`relayer-service/server.js`) -- Sponsored setup, fee bumps, Add Money distribution, authentication
- **Authentication** (`App/src/services/auth.ts`) -- Supabase OTP session handling

## What We Ask

- Do not access or attempt to access other users' wallets, keys, or data.
- Do not attempt transactions on production networks with real funds during testing.
- Do not disclose vulnerability details publicly until a fix is released.
- Give us reasonable time to address the issue before public disclosure.

## Out of Scope

- Issues in third-party dependencies (report these upstream)
- Social engineering attacks
- Issues that require physical access to a user's device
- Stellar testnet-only issues with no production impact

## Recognition

We appreciate security researchers who help improve C-Pay. With your permission, we will acknowledge your contribution in release notes.
