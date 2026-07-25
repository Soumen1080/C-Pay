/**
 * Unit tests for getPaymentFailureCopy.
 * Covers every named error code and the fallback path.
 */

import { getPaymentFailureCopy } from '../../utils/paymentFailure';

describe('getPaymentFailureCopy', () => {
  // ──────────────────────────────────────────────────────
  // AUTH_REQUIRED / JWT / authentication errors
  // ──────────────────────────────────────────────────────
  test('AUTH_REQUIRED code → session expired, support category', () => {
    const copy = getPaymentFailureCopy({ code: 'AUTH_REQUIRED' });
    expect(copy.errorMessage).toContain('Session');
    expect(copy.category).toBe('support');
    expect(copy.errorCode).toBe('AUTH_REQUIRED');
  });

  test('message containing "jwt" → session expired, support category', () => {
    const copy = getPaymentFailureCopy({ message: 'jwt expired' });
    expect(copy.category).toBe('support');
    expect(copy.errorMessage.toLowerCase()).toContain('session');
  });

  // ──────────────────────────────────────────────────────
  // Contract-specific support codes
  // ──────────────────────────────────────────────────────
  test('CONTRACT_MERCHANT_MISSING → merchant not ready, support category', () => {
    const copy = getPaymentFailureCopy({ code: 'CONTRACT_MERCHANT_MISSING' });
    expect(copy.errorMessage).toMatch(/merchant/i);
    expect(copy.category).toBe('support');
  });

  test('CONTRACT_MERCHANT_INACTIVE → merchant inactive, support category', () => {
    const copy = getPaymentFailureCopy({ code: 'CONTRACT_MERCHANT_INACTIVE' });
    expect(copy.errorMessage).toMatch(/inactive/i);
    expect(copy.category).toBe('support');
  });

  test('CONTRACT_MERCHANT_MISMATCH → QR code mismatch, support category', () => {
    const copy = getPaymentFailureCopy({ code: 'CONTRACT_MERCHANT_MISMATCH' });
    expect(copy.errorMessage).toMatch(/mismatch|qr/i);
    expect(copy.category).toBe('support');
  });

  test('CONTRACT_INTENT_SOURCE_MISMATCH → wallet mismatch, support category', () => {
    const copy = getPaymentFailureCopy({ code: 'CONTRACT_INTENT_SOURCE_MISMATCH' });
    expect(copy.errorMessage).toMatch(/wallet/i);
    expect(copy.category).toBe('support');
  });

  test('CONTRACT_INTENT_AMOUNT_MISMATCH → amount changed, support category', () => {
    const copy = getPaymentFailureCopy({ code: 'CONTRACT_INTENT_AMOUNT_MISMATCH' });
    expect(copy.errorMessage).toMatch(/amount/i);
    expect(copy.category).toBe('support');
  });

  // ──────────────────────────────────────────────────────
  // Retryable errors
  // ──────────────────────────────────────────────────────
  test('timeout message → retryable category', () => {
    const copy = getPaymentFailureCopy({ message: 'request timeout' });
    expect(copy.category).toBe('retryable');
    expect(copy.errorMessage).toMatch(/timeout|network/i);
  });

  test('RELAYER_TIMEOUT code → retryable category', () => {
    const copy = getPaymentFailureCopy({ code: 'RELAYER_TIMEOUT' });
    expect(copy.category).toBe('retryable');
  });

  test('insufficient balance message → retryable category', () => {
    const copy = getPaymentFailureCopy({ message: 'insufficient balance' });
    expect(copy.category).toBe('retryable');
    expect(copy.errorMessage).toMatch(/balance/i);
  });

  test('STELLAR_OP_UNDERFUNDED code → retryable category', () => {
    const copy = getPaymentFailureCopy({ code: 'STELLAR_OP_UNDERFUNDED' });
    expect(copy.category).toBe('retryable');
  });

  test('network fetch failure → retryable category', () => {
    const copy = getPaymentFailureCopy({ message: 'failed to fetch' });
    expect(copy.category).toBe('retryable');
    expect(copy.errorMessage).toMatch(/network|connection/i);
  });

  test('RELAYER_UNREACHABLE code → retryable category', () => {
    const copy = getPaymentFailureCopy({ code: 'RELAYER_UNREACHABLE' });
    expect(copy.category).toBe('retryable');
  });

  test('service unavailable message → retryable category', () => {
    const copy = getPaymentFailureCopy({ message: 'service unavailable' });
    expect(copy.category).toBe('retryable');
  });

  // ──────────────────────────────────────────────────────
  // Error detail extraction paths
  // ──────────────────────────────────────────────────────
  test('reads error text from details.error when present', () => {
    const copy = getPaymentFailureCopy({ details: { error: 'insufficient balance' } });
    expect(copy.category).toBe('retryable');
  });

  test('reads error code from details.code when present', () => {
    const copy = getPaymentFailureCopy({ details: { code: 'AUTH_REQUIRED', error: 'auth' } });
    expect(copy.category).toBe('support');
  });

  // ──────────────────────────────────────────────────────
  // Fallback for unknown errors
  // ──────────────────────────────────────────────────────
  test('unknown error → generic fallback, retryable category', () => {
    const copy = getPaymentFailureCopy({ message: 'something went wrong' });
    expect(copy.category).toBe('retryable');
    expect(copy.errorMessage).toBeTruthy();
  });

  test('null error → generic fallback, retryable category', () => {
    const copy = getPaymentFailureCopy(null);
    expect(copy.category).toBe('retryable');
    expect(copy.errorMessage).toBeTruthy();
    expect(copy.errorReason).toBeTruthy();
  });

  test('empty object → generic fallback, retryable category', () => {
    const copy = getPaymentFailureCopy({});
    expect(copy.category).toBe('retryable');
  });

  // ──────────────────────────────────────────────────────
  // Shape of returned object
  // ──────────────────────────────────────────────────────
  test('always returns errorMessage and errorReason strings', () => {
    const copy = getPaymentFailureCopy({ code: 'UNKNOWN_CODE' });
    expect(typeof copy.errorMessage).toBe('string');
    expect(typeof copy.errorReason).toBe('string');
    expect(copy.errorMessage.length).toBeGreaterThan(0);
    expect(copy.errorReason.length).toBeGreaterThan(0);
  });
});
