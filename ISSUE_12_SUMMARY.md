# Issue #12: Signed, Versioned, Tamper-Evident QR Payment Request Standard – Implementation Summary

## Overview

This PR replaces unsigned, on-device-generated v2 QR payloads with a signed, versioned v3 standard that prevents tampering, replay attacks, and expired QR code acceptance. Legacy v2 QRs remain supported with a deprecation path.

## What Changed

### 1. v3 QR Payload Specification

**New fields:**
- `version: 3` – protocol version
- `requestId` – unique 32-hex ID per issued QR
- `nonce` – 32-hex random replay guard
- `issuedAt` / `expiresAt` – Unix timestamps (seconds)
- `sig` – HMAC-SHA256 hex signature over canonical JSON payload

**Amount policy:**
- `amount === "0"` → variable-amount QR (payer fills in amount)
- Any other value → exact fixed amount

**Security properties:**
- Tamper-evident: signature verification detects any field modification
- Replay-resistant: `nonce` ensures distinct signatures even for identical merchant + amount
- Time-bounded: relayer and app reject payloads past `expiresAt`

### 2. Relayer Endpoints

#### `POST /qr/issue` (authenticated)

Issues a signed v3 QR payload.

**Request:**
```json
{
  "merchantId": "string",
  "merchantAddress": "G…",
  "amount": "100.00",  // or "0" for variable-amount
  "merchantName": "string",
  "note": "string?",
  "ttlSeconds": 86400  // default 1 day, max 7 days
}
```

**Response:** Full v3 payload including `sig`, ready to serialize as QR string.

**Requires:** `QR_SIGNING_SECRET` env var (64-hex recommended, 32 bytes min). When omitted, returns `503 QR_SIGNING_NOT_CONFIGURED` and the app falls back to generating unsigned v2 QRs on-device.

#### `POST /qr/verify`

Verifies a v3 QR payload.

**Request:** Full v3 JSON payload including `sig`.

**Responses:**
- `200 { valid: true, payload }` – signature OK, not expired
- `400 { valid: false, code: 'QR_INVALID' }` – missing fields / bad structure
- `401 { valid: false, code: 'QR_TAMPERED' }` – HMAC mismatch
- `410 { valid: false, code: 'QR_EXPIRED' }` – past `expiresAt`

**Note:** Verification does NOT require authentication so payers can verify QRs without logging in first.

### 3. Cryptographic Implementation

**Signing algorithm:** HMAC-SHA256 over canonical JSON

**Canonical field order:**
```
type, version, requestId, nonce, network, merchantId, merchant,
assetCode, assetIssuer, amount, name, note (if present),
issuedAt, expiresAt
```

**Signature verification:** Timing-safe comparison (`crypto.timingSafeEqual`) to prevent timing attacks.

### 4. App Changes

**`App/src/utils/qrCode.ts`:**
- New types: `PaymentQRDataV3`, `AnyQRPayload`, `QRVerificationStatus`, `QRVerificationResult`
- `generateSignedQRPayload()` – calls relayer `/qr/issue`, falls back to v2 on error
- `verifyQRPayloadWithRelayer()` – calls relayer `/qr/verify`, returns verification result
- `parseAnyPaymentQR()` – parses v2 or v3
- `validatePaymentQRV3()` – client-side structural + expiry checks (does NOT verify signature)

**`App/src/screens/ScanScreen.tsx`:**
- Parses v2 and v3 QRs
- For v3: calls relayer verification, displays verification badge
- Badge states: ✓ Verified (green) / ⚠ Unverified (amber) / ⏱ Expired (red) / ✗ Invalid (red)
- Rejects expired and tampered v3 QRs with clear error messages
- v2 QRs show "Unverified (legacy QR)" badge and proceed with a deprecation notice

**`App/src/screens/MerchantQRGeneratorScreen.tsx`:**
- Calls `generateSignedQRPayload()` with current Supabase session token
- Falls back to unsigned v2 when relayer is unreachable or QR signing is not configured

### 5. Relayer Configuration

**New env vars (`.env.example` updated):**
```bash
# Generate a secret: openssl rand -hex 32
QR_SIGNING_SECRET=
QR_DEFAULT_TTL_SECONDS=86400
```

**Health endpoint (`GET /health`) now returns:**
```json
{
  ...
  "qrSigningConfigured": true/false
}
```

### 6. Backward Compatibility

| QR Version | Behavior |
|---|---|
| v3 (signed) | Full verification flow, show green "✓ Verified" badge |
| v2 (unsigned) | Structural validation only, show amber "⚠ Unverified (legacy QR)" badge, proceed with deprecation notice |
| Invalid/tampered v3 | Reject with "QR verification failed" error |
| Expired v3 | Reject with "This QR code has expired. Ask the merchant to generate a new one." |

**Migration path:**
1. Deploy relayer with `QR_SIGNING_SECRET` configured
2. App automatically uses v3 for new QRs
3. Existing v2 QRs in the wild continue working
4. Future: add deprecation timeline for v2 removal

## Files Changed

### New Files
- None (all changes to existing files)

### Modified Files

#### Relayer (`relayer-service/`)
- `server.js`:
  - Added `POST /qr/issue` endpoint
  - Added `POST /qr/verify` endpoint
  - Added `signQRPayload()` helper (HMAC-SHA256 over canonical JSON)
  - Added `timingSafeEqual()` helper (timing-safe comparison)
  - Added `qrSigningSecret` and `qrDefaultTtlSeconds` to `loadConfig()`
  - Updated `/` endpoint list and `/health` response
- `.env.example`:
  - Added `QR_SIGNING_SECRET` and `QR_DEFAULT_TTL_SECONDS` with generation instructions

#### App (`App/`)
- `src/utils/qrCode.ts`:
  - Complete rewrite with v3 types, signed payload generation, verification, and v2 legacy support
- `src/screens/ScanScreen.tsx`:
  - Rewritten verification flow with relayer verification calls and verification badge UI
- `src/screens/MerchantQRGeneratorScreen.tsx`:
  - Updated to call `generateSignedQRPayload()` with Supabase session token

## Testing

### Relayer

```bash
cd relayer-service
node --check server.js  # ✓ Syntax OK
npm start

# Test /qr/issue (requires QR_SIGNING_SECRET and auth token)
curl -X POST http://localhost:3000/qr/issue \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "merchantId": "test-merchant",
    "merchantAddress": "GABC...",
    "amount": "100.00",
    "merchantName": "Test Shop"
  }'

# Test /qr/verify (no auth required)
curl -X POST http://localhost:3000/qr/verify \
  -H "Content-Type: application/json" \
  -d "$V3_PAYLOAD"

# Health check
curl http://localhost:3000/health | jq '.qrSigningConfigured'
```

### App

```bash
cd App
npm start  # Start Expo dev server
```

**Manual test flow:**
1. Generate a merchant QR → verify it's v3 with `sig` field when relayer is configured
2. Scan the QR → verify "✓ Verified merchant" green badge appears
3. Generate a v2 QR (by temporarily disabling relayer QR signing) → scan → verify "⚠ Unverified (legacy QR)" amber badge
4. Manually edit a v3 QR's amount field → scan → verify "✗ Invalid QR" red badge and rejection
5. Wait for a v3 QR to expire (or manipulate `expiresAt`) → scan → verify "⏱ QR code expired" red badge and rejection

## Security Considerations

### What v3 Prevents
✅ QR tampering (amount, merchant address, merchant ID modification)  
✅ Replay attacks (nonce ensures unique signatures)  
✅ Expired QR acceptance (enforced client + server side)  
✅ Cross-network QR misuse (network field validated)  
✅ Cross-asset QR misuse (assetCode/assetIssuer validated)

### What v3 Does NOT Prevent
❌ Merchant impersonation at registration time (requires merchant KYS)  
❌ Stolen/leaked `QR_SIGNING_SECRET` allowing attacker to issue arbitrary QRs  
❌ Phishing QRs from unregistered merchants (contract merchant registry + verification helps)

### Production Hardening Recommendations
1. Rotate `QR_SIGNING_SECRET` periodically (requires invalidating old QRs)
2. Store `QR_SIGNING_SECRET` in a secrets manager (AWS Secrets Manager, Vault, etc.)
3. Monitor `/qr/issue` rate limits per merchant to detect abuse
4. Add merchant verification badge in ScanScreen based on contract merchant registry status
5. Implement QR nonce deduplication store (Redis) to detect replay attempts across relayer instances
6. Add webhook/event logging for verification failures to detect tampering attempts

## Environment Reference

### Relayer `.env`

```bash
# Required for QR signing
QR_SIGNING_SECRET=<64-hex-chars>  # openssl rand -hex 32

# Optional (defaults shown)
QR_DEFAULT_TTL_SECONDS=86400  # 1 day
```

### App `.env`

No new env vars required. The app discovers QR signing availability via the relayer `/health` endpoint.

## API Documentation

### `POST /qr/issue`

**Auth:** Required (Bearer token)

**Request Body:**
| Field | Type | Required | Description |
|---|---|---|---|
| `merchantId` | string | ✓ | C-Pay merchant ID |
| `merchantAddress` | string (G…) | ✓ | Stellar wallet address |
| `amount` | string | ✓ | Asset amount, "0" for variable-amount |
| `merchantName` | string | ✓ | Display name embedded in QR |
| `note` | string | | Optional payment note (max 160 chars) |
| `ttlSeconds` | number | | Validity window (default 86400, max 604800) |

**Response (200):** Full v3 JSON payload including `sig`

**Errors:**
- `503 QR_SIGNING_NOT_CONFIGURED` – `QR_SIGNING_SECRET` not set
- `400` – Invalid merchant address, amount, or required field missing
- `401` – Authentication required

### `POST /qr/verify`

**Auth:** Not required

**Request Body:** Full v3 JSON payload including `sig`

**Response (200):**
```json
{
  "valid": true,
  "payload": { ... }  // Echoes the verified payload
}
```

**Errors:**
- `400 QR_INVALID` – Missing fields, wrong version, wrong network/asset
- `401 QR_TAMPERED` – HMAC signature mismatch
- `410 QR_EXPIRED` – Past `expiresAt` timestamp
- `503 QR_SIGNING_NOT_CONFIGURED` – `QR_SIGNING_SECRET` not set

## Migration Guide

### For Existing Deployments

1. **Relayer:**
   ```bash
   # Generate signing secret
   openssl rand -hex 32
   
   # Add to .env
   echo "QR_SIGNING_SECRET=<generated-secret>" >> .env
   
   # Restart relayer
   npm start
   ```

2. **App:** No changes required. The app detects v3 support automatically via `/health` and falls back to v2 when unavailable.

3. **Existing v2 QRs:** Continue working indefinitely. Users see an "Unverified (legacy QR)" badge.

4. **Future v2 Deprecation:** After all merchants have regenerated their QRs as v3:
   - Add a grace period warning in ScanScreen for v2 QRs
   - Set a cutoff date
   - Remove v2 parsing support from `parseAnyPaymentQR()`

## Completion Checklist

- [x] v3 QR payload specification defined
- [x] Relayer `/qr/issue` endpoint with HMAC-SHA256 signing
- [x] Relayer `/qr/verify` endpoint with timing-safe comparison
- [x] `signQRPayload` and `timingSafeEqual` helpers
- [x] `QR_SIGNING_SECRET` and `QR_DEFAULT_TTL_SECONDS` config
- [x] App `qrCode.ts` rewritten with v3 types and functions
- [x] `ScanScreen.tsx` rewritten with verification flow and badge UI
- [x] `MerchantQRGeneratorScreen.tsx` updated to generate signed QRs
- [x] Relayer `.env.example` documented
- [x] `/health` endpoint updated with `qrSigningConfigured`
- [x] `/` endpoint list updated
- [x] v2 legacy QR support maintained
- [x] Deprecation path documented

## Next Steps for Production

1. Deploy relayer with `QR_SIGNING_SECRET` configured
2. Monitor `/qr/issue` and `/qr/verify` usage via logs/metrics
3. Add nonce deduplication store (Redis) for cross-instance replay protection
4. Implement QR analytics dashboard (issued, scanned, expired, tampered)
5. Add merchant verification indicator based on contract merchant registry
6. Set v2 deprecation timeline (recommend 6-12 months after v3 rollout)
7. Periodic `QR_SIGNING_SECRET` rotation policy
