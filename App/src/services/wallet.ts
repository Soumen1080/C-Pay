/**
 * @file wallet.ts
 * @description Local Stellar wallet: key generation, PIN-based encryption,
 *   biometric backup, session caching, and PIN lockout / backoff.
 *
 * ─── Security design notes ───────────────────────────────────────────────────
 *
 * PIN verifier KDF  (PIN_KDF_ITERATIONS = 20 000)
 *   PBKDF2-SHA256 over the salted PIN, used only to verify the PIN at login.
 *   The iteration count is lower than the wallet KDF because it runs every
 *   login attempt (including during backoff checks).  All attempts after the
 *   first few are rate-limited by the lockout policy, so the effective work
 *   factor for an attacker is the lockout delay × iterations, not iterations
 *   alone.  Legacy verifiers used 120 000 iterations and are migrated
 *   transparently on successful login.
 *
 * Wallet encryption KDF  (WALLET_KDF_ITERATIONS = 80 000)
 *   PBKDF2-SHA256 over the salted PIN, used to derive the AES-equivalent
 *   key for wallet encryption.  Higher than the verifier because it is only
 *   called on successful unlock — the extra cost is paid once per session.
 *
 * Wallet cipher  (XChaCha20-Poly1305)
 *   Chosen over AES-GCM for its larger 192-bit nonce (eliminates nonce-reuse
 *   risk) and constant-time software implementation via @noble/ciphers.
 *
 * Session cache  (SESSION_PIN_TTL_MS = 15 min)
 *   The decrypted wallet and the PIN are held in module-level variables after
 *   a successful unlock.  They expire after 15 minutes of non-use and are
 *   explicitly cleared when the app goes to background (see App.tsx) or the
 *   user signs out.  The raw PIN is cached (not only the hash) so that
 *   wallet signing calls inside the session TTL do not require re-entry.
 *
 * PIN lockout policy  (MAX_PIN_ATTEMPTS = 5, LOCKOUT_BASE_MS = 30 000)
 *   After 5 consecutive wrong PINs the account enters a timed lockout.
 *   Each subsequent wrong attempt doubles the base delay (exponential
 *   backoff) up to MAX_LOCKOUT_MS = 1 hour.  The attempt counter and
 *   lockout-until timestamp are written to SecureStore so they survive
 *   app restarts and cannot be reset by simply force-quitting the app.
 *   A successful PIN clears the counter.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import * as StellarSdk from '@stellar/stellar-base';
import { Buffer } from 'buffer';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8 } from '@noble/ciphers/utils';
import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';

// ─── SecureStore keys ─────────────────────────────────────────────────────────
const WALLET_KEY = 'cpay_stellar_wallet';
const PIN_KEY = 'cpay_pin_hash';
const SALT_KEY = 'cpay_pin_salt';
const BIOMETRIC_BACKUP_KEY = 'cpay_stellar_biometric_backup';
const BIOMETRIC_BACKUP_AVAILABLE_KEY = 'cpay_stellar_biometric_backup_available';
/** Persisted PIN attempt state: { attempts, lockedUntil } */
const PIN_ATTEMPTS_KEY = 'cpay_pin_attempts';

// ─── Versioning & KDF constants ───────────────────────────────────────────────
const WALLET_STORAGE_VERSION = 4;
const PIN_VERIFIER_VERSION = 2;
/** Legacy PBKDF2 iterations used before v2 verifiers. Migrated on next login. */
const LEGACY_PIN_KDF_ITERATIONS = 120_000;
/** PBKDF2-SHA256 iterations for the PIN *verifier* (login check). */
const PIN_KDF_ITERATIONS = 20_000;
/** PBKDF2-SHA256 iterations for *wallet* key derivation (paid once per session). */
const WALLET_KDF_ITERATIONS = 80_000;

// ─── Session TTL ──────────────────────────────────────────────────────────────
/** Wallet and PIN stay in memory for this many milliseconds after last use. */
const SESSION_PIN_TTL_MS = 15 * 60 * 1000;
/** Exported for display in the Security Centre screen. */
export const SESSION_TIMEOUT_MINUTES = Math.round(SESSION_PIN_TTL_MS / 60_000);

// ─── Lockout policy ───────────────────────────────────────────────────────────
/** Wrong PINs allowed before the first lockout is imposed. */
export const MAX_PIN_ATTEMPTS = 5;
/** Base lockout duration in ms. Doubles on each subsequent wrong attempt. */
export const LOCKOUT_BASE_MS = 30_000; // 30 seconds
/** Hard ceiling for any single lockout period. */
export const MAX_LOCKOUT_MS = 60 * 60 * 1000; // 1 hour

// ─── Types ────────────────────────────────────────────────────────────────────

type StoredWalletPayload = {
  version: 4;
  publicKey: string;
  cipher: 'xchacha20-poly1305';
  kdf: 'pbkdf2-sha256';
  kdfIterations: number;
  salt: string;
  nonce: string;
  ciphertext: string;
  updatedAt: string;
};

type StoredBiometricPayload = {
  version: 1;
  publicKey: string;
  secret: string;
  updatedAt: string;
};

type StoredPinVerifierPayload = {
  version: 2;
  kdf: 'pbkdf2-sha256';
  kdfIterations: number;
  hash: string;
  updatedAt: string;
};

type CachedPin = {
  pin: string;
  expiresAt: number;
};

type CachedWallet = {
  wallet: StellarWallet;
  expiresAt: number;
};

/** Persisted attempt state written to SecureStore. */
export type PinAttemptState = {
  /** Total consecutive wrong attempts since last success. */
  attempts: number;
  /** Timestamp (ms) when the current lockout ends; 0 if not locked. */
  lockedUntil: number;
};

export type StellarWallet = {
  address: string;
  publicKey: string;
  secret: string;
  keypair: StellarSdk.Keypair;
  signXdr: (xdr: string, networkPassphrase: string) => string;
};

type VerifyPinOptions = {
  migrate?: boolean;
  blockMigration?: boolean;
};

// ─── In-memory session state ──────────────────────────────────────────────────

let cachedPinHash: string | null = null;
let cachedPin: CachedPin | null = null;
let cachedWallet: CachedWallet | null = null;

// ─── Session helpers ──────────────────────────────────────────────────────────

export function cachePinForSession(pin: string, ttlMs: number = SESSION_PIN_TTL_MS): void {
  cachedPin = { pin, expiresAt: Date.now() + ttlMs };
}

export function clearSessionPin(): void {
  cachedPin = null;
  cachedWallet = null;
}

function getCachedPin(): string | null {
  if (!cachedPin) return null;
  if (Date.now() >= cachedPin.expiresAt) {
    cachedPin = null;
    return null;
  }
  return cachedPin.pin;
}

// ─── Lockout / attempt tracking ───────────────────────────────────────────────

/**
 * Read the current PIN attempt state from SecureStore.
 * Returns a zeroed state if nothing is stored yet.
 */
export async function getPinAttemptState(): Promise<PinAttemptState> {
  try {
    const raw = await SecureStore.getItemAsync(PIN_ATTEMPTS_KEY);
    if (!raw) return { attempts: 0, lockedUntil: 0 };
    const parsed = JSON.parse(raw) as Partial<PinAttemptState>;
    return {
      attempts: typeof parsed.attempts === 'number' ? parsed.attempts : 0,
      lockedUntil: typeof parsed.lockedUntil === 'number' ? parsed.lockedUntil : 0,
    };
  } catch {
    return { attempts: 0, lockedUntil: 0 };
  }
}

/**
 * Record a failed PIN attempt.  Computes and persists the next lockout window
 * using exponential backoff.  Returns the updated state.
 */
export async function recordFailedPinAttempt(): Promise<PinAttemptState> {
  const current = await getPinAttemptState();
  const attempts = current.attempts + 1;

  let lockedUntil = 0;
  if (attempts >= MAX_PIN_ATTEMPTS) {
    // Extra attempts beyond the threshold double the delay each time.
    const extraAttempts = attempts - MAX_PIN_ATTEMPTS;
    const delay = Math.min(LOCKOUT_BASE_MS * Math.pow(2, extraAttempts), MAX_LOCKOUT_MS);
    lockedUntil = Date.now() + delay;
  }

  const next: PinAttemptState = { attempts, lockedUntil };
  await SecureStore.setItemAsync(PIN_ATTEMPTS_KEY, JSON.stringify(next));
  return next;
}

/**
 * Clear the attempt counter after a successful PIN verification.
 */
export async function clearPinAttempts(): Promise<void> {
  await SecureStore.deleteItemAsync(PIN_ATTEMPTS_KEY);
}

/**
 * Returns true when the user is currently locked out (lockedUntil > now).
 */
export function isLockedOut(state: PinAttemptState): boolean {
  return state.lockedUntil > Date.now();
}

/**
 * Milliseconds remaining in the current lockout (0 if not locked).
 */
export function lockoutRemainingMs(state: PinAttemptState): number {
  if (!isLockedOut(state)) return 0;
  return state.lockedUntil - Date.now();
}

// ─── Core wallet API ──────────────────────────────────────────────────────────

export async function getWalletFromSession(): Promise<StellarWallet | null> {
  const wallet = getCachedWallet();
  if (wallet) return wallet;

  const pin = getCachedPin();
  if (!pin) return null;

  return getWallet(pin);
}

export async function createWallet(pin: string): Promise<string> {
  const keypair = StellarSdk.Keypair.random();
  const publicKey = keypair.publicKey();
  const secret = keypair.secret();

  await Promise.all([storeSecret(secret, pin), storePinVerifier(pin)]);
  cachePinForSession(pin);
  cacheWalletForSession(secret);

  return publicKey;
}

export async function getWallet(pin: string): Promise<StellarWallet | null> {
  try {
    const isValidPin = await verifyPin(pin);
    if (!isValidPin) {
      throw new Error('Invalid PIN');
    }

    const secret = await readSecret(pin);
    if (!secret) return null;

    cachePinForSession(pin);
    return cacheWalletForSession(secret);
  } catch (error) {
    console.error('Error getting wallet:', error);
    return null;
  }
}

export async function getWalletFromBiometricBackup(
  authenticationPrompt: string = 'Unlock wallet',
): Promise<StellarWallet | null> {
  const secret = await recoverWalletWithBiometric(authenticationPrompt);
  if (!secret) return null;
  return createWalletObject(secret);
}

export async function hasWallet(): Promise<boolean> {
  try {
    const wallet = await SecureStore.getItemAsync(WALLET_KEY);
    const pin = await SecureStore.getItemAsync(PIN_KEY);
    return !!wallet && !!pin;
  } catch (error) {
    console.error('Error checking wallet:', error);
    return false;
  }
}

export async function verifyPin(pin: string, options: VerifyPinOptions = {}): Promise<boolean> {
  try {
    const { migrate = true, blockMigration = true } = options;
    const [storedPinVerifier, saltHex] = await Promise.all([
      SecureStore.getItemAsync(PIN_KEY),
      SecureStore.getItemAsync(SALT_KEY),
    ]);

    if (!storedPinVerifier || !saltHex) return false;

    const verifier = parsePinVerifier(storedPinVerifier);
    const pinHash = await hashPinWithSalt(pin, saltHex, verifier.kdfIterations);
    const isValid = verifier.hash === pinHash;

    if (isValid) {
      cachedPinHash = pinHash;
      cachePinForSession(pin);

      if (verifier.needsMigration && migrate) {
        const migration = storePinVerifier(pin);
        if (blockMigration) {
          await migration;
        } else {
          void migration.catch((error) => {
            console.warn('PIN verifier migration failed:', error);
          });
        }
      }
    }

    return isValid;
  } catch (error) {
    console.error('Error verifying PIN:', error);
    return false;
  }
}

export async function changeWalletPin(oldPin: string, newPin: string): Promise<void> {
  const isValidOldPin = await verifyPin(oldPin, { migrate: false });
  if (!isValidOldPin) throw new Error('Invalid current PIN');

  const secret = await readSecret(oldPin);
  if (!secret) throw new Error('Wallet not found');

  await SecureStore.deleteItemAsync(SALT_KEY);
  await storeSecret(secret, newPin);
  await storePinVerifier(newPin);
  cachePinForSession(newPin);
  cacheWalletForSession(secret);
}

// ─── PIN verifier helpers ─────────────────────────────────────────────────────

async function storePinVerifier(pin: string): Promise<void> {
  const pinHash = await hashPin(pin);
  const payload: StoredPinVerifierPayload = {
    version: PIN_VERIFIER_VERSION,
    kdf: 'pbkdf2-sha256',
    kdfIterations: PIN_KDF_ITERATIONS,
    hash: pinHash,
    updatedAt: new Date().toISOString(),
  };
  await SecureStore.setItemAsync(PIN_KEY, JSON.stringify(payload));
  cachedPinHash = pinHash;
}

async function hashPin(pin: string): Promise<string> {
  let saltHex = await SecureStore.getItemAsync(SALT_KEY);
  if (!saltHex) {
    saltHex = bytesToHex(await Crypto.getRandomBytesAsync(16));
    await SecureStore.setItemAsync(SALT_KEY, saltHex);
  }
  return hashPinWithSalt(pin, saltHex, PIN_KDF_ITERATIONS);
}

function parsePinVerifier(stored: string): {
  hash: string;
  kdfIterations: number;
  needsMigration: boolean;
} {
  try {
    const payload = JSON.parse(stored) as Partial<StoredPinVerifierPayload>;
    if (
      payload.version === PIN_VERIFIER_VERSION &&
      payload.kdf === 'pbkdf2-sha256' &&
      payload.hash &&
      payload.kdfIterations
    ) {
      return {
        hash: payload.hash,
        kdfIterations: payload.kdfIterations,
        needsMigration: payload.kdfIterations !== PIN_KDF_ITERATIONS,
      };
    }
  } catch {
    // Legacy verifier was stored as a raw hex hash.
  }

  return { hash: stored, kdfIterations: LEGACY_PIN_KDF_ITERATIONS, needsMigration: true };
}

async function hashPinWithSalt(pin: string, saltHex: string, iterations: number): Promise<string> {
  const verifier = await pbkdf2Async(
    sha256,
    utf8ToBytes(`pin-verifier:${pin}`),
    hexToBytes(saltHex),
    { c: iterations, dkLen: 32 },
  );
  return bytesToHex(verifier);
}

async function deriveWalletKey(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  return pbkdf2Async(
    sha256,
    utf8ToBytes(`wallet-secret:${pin}`),
    salt,
    { c: iterations, dkLen: 32 },
  );
}

// ─── Wallet encryption ────────────────────────────────────────────────────────

async function storeSecret(secret: string, pin: string): Promise<void> {
  const wallet = createWalletObject(secret);
  const salt = await Crypto.getRandomBytesAsync(16);
  const nonce = await Crypto.getRandomBytesAsync(24);
  const key = await deriveWalletKey(pin, salt, WALLET_KDF_ITERATIONS);
  const cipher = xchacha20poly1305(key, nonce);
  const ciphertext = cipher.encrypt(utf8ToBytes(secret));

  const payload: StoredWalletPayload = {
    version: WALLET_STORAGE_VERSION,
    publicKey: wallet.publicKey,
    cipher: 'xchacha20-poly1305',
    kdf: 'pbkdf2-sha256',
    kdfIterations: WALLET_KDF_ITERATIONS,
    salt: bytesToHex(salt),
    nonce: bytesToHex(nonce),
    ciphertext: bytesToHex(ciphertext),
    updatedAt: new Date().toISOString(),
  };

  await SecureStore.setItemAsync(WALLET_KEY, JSON.stringify(payload));
}

async function readSecret(pin: string): Promise<string | null> {
  const stored = await SecureStore.getItemAsync(WALLET_KEY);
  if (!stored) return null;

  try {
    const payload = JSON.parse(stored) as Partial<StoredWalletPayload>;
    if (
      payload.version !== WALLET_STORAGE_VERSION ||
      payload.cipher !== 'xchacha20-poly1305' ||
      payload.kdf !== 'pbkdf2-sha256' ||
      !payload.salt ||
      !payload.nonce ||
      !payload.ciphertext ||
      !payload.kdfIterations
    ) {
      return null;
    }

    const key = await deriveWalletKey(pin, hexToBytes(payload.salt), payload.kdfIterations);
    const cipher = xchacha20poly1305(key, hexToBytes(payload.nonce));
    const plaintext = cipher.decrypt(hexToBytes(payload.ciphertext));
    const secret = bytesToUtf8(plaintext);

    if (StellarSdk.StrKey.isValidEd25519SecretSeed(secret)) return secret;
  } catch (error) {
    console.error('Wallet decrypt failed:', error);
    return null;
  }

  return null;
}

// ─── Biometric backup ─────────────────────────────────────────────────────────

async function storeBiometricBackup(
  secret: string,
  authenticationPrompt: string = 'Secure wallet recovery',
): Promise<boolean> {
  const wallet = createWalletObject(secret);
  const payload: StoredBiometricPayload = {
    version: 1,
    publicKey: wallet.publicKey,
    secret,
    updatedAt: new Date().toISOString(),
  };

  try {
    await SecureStore.setItemAsync(BIOMETRIC_BACKUP_KEY, JSON.stringify(payload), {
      requireAuthentication: true,
      authenticationPrompt,
    });
    await SecureStore.setItemAsync(BIOMETRIC_BACKUP_AVAILABLE_KEY, 'true');
    return true;
  } catch (error) {
    console.warn('Biometric backup could not be stored:', error);
    await SecureStore.deleteItemAsync(BIOMETRIC_BACKUP_AVAILABLE_KEY);
    return false;
  }
}

export async function enableWalletBiometricBackup(
  authenticationPrompt: string = 'Enable biometric unlock',
  secretOverride?: string,
): Promise<boolean> {
  const wallet = secretOverride ? null : await getWalletFromSession();
  const secret = secretOverride || wallet?.secret;
  if (!secret) throw new Error('Unlock with PIN before enabling biometric authentication');
  return storeBiometricBackup(secret, authenticationPrompt);
}

export async function clearBiometricBackup(): Promise<void> {
  await SecureStore.deleteItemAsync(BIOMETRIC_BACKUP_KEY);
  await SecureStore.deleteItemAsync(BIOMETRIC_BACKUP_AVAILABLE_KEY);
}

export async function clearWallet(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(WALLET_KEY);
    await SecureStore.deleteItemAsync(SALT_KEY);
    await SecureStore.deleteItemAsync(BIOMETRIC_BACKUP_KEY);
    await SecureStore.deleteItemAsync(BIOMETRIC_BACKUP_AVAILABLE_KEY);
    await SecureStore.deleteItemAsync(PIN_KEY);
    await SecureStore.deleteItemAsync(PIN_ATTEMPTS_KEY);
    cachedPinHash = null;
    clearSessionPin();
  } catch (error) {
    console.error('Error clearing wallet:', error);
  }
}

export async function recoverWalletWithBiometric(
  authenticationPrompt: string = 'Unlock wallet to reset PIN',
): Promise<string | null> {
  try {
    const stored = await SecureStore.getItemAsync(BIOMETRIC_BACKUP_KEY, {
      authenticationPrompt,
      requireAuthentication: true,
    });

    if (!stored) return null;

    const secret = parseBiometricSecret(stored);
    if (!secret) throw new Error('Invalid wallet backup');
    return secret;
  } catch (error: any) {
    if (error.message?.includes('cancel') || error.message?.includes('Authentication canceled')) {
      throw new Error('Authentication cancelled');
    }
    if (error.message?.includes('failed') || error.message?.includes('not recognized')) {
      throw new Error('Biometric authentication failed. Please try again.');
    }
    if (error.message?.includes('not found') || error.message?.includes('no entry')) {
      throw new Error('No biometric backup available. Wallet was created without biometric support.');
    }
    throw new Error('Failed to recover wallet. Please contact support.');
  }
}

function parseBiometricSecret(stored: string): string | null {
  try {
    const payload = JSON.parse(stored) as Partial<StoredBiometricPayload>;
    if (payload.secret && StellarSdk.StrKey.isValidEd25519SecretSeed(payload.secret)) {
      return payload.secret;
    }
  } catch {
    if (StellarSdk.StrKey.isValidEd25519SecretSeed(stored)) return stored;
  }
  return null;
}

export async function hasBiometricBackup(): Promise<boolean> {
  try {
    const backupFlag = await SecureStore.getItemAsync(BIOMETRIC_BACKUP_AVAILABLE_KEY);
    return backupFlag === 'true';
  } catch {
    return false;
  }
}

export async function recreateWalletFromSecret(secret: string, newPin: string): Promise<string> {
  if (!StellarSdk.StrKey.isValidEd25519SecretSeed(secret)) throw new Error('Invalid wallet backup');
  const wallet = createWalletObject(secret);
  await storeSecret(secret, newPin);
  await SecureStore.deleteItemAsync(SALT_KEY);
  await storePinVerifier(newPin);
  cachePinForSession(newPin);
  cacheWalletForSession(secret);
  return wallet.publicKey;
}

// ─── Session wallet cache ─────────────────────────────────────────────────────

function getCachedWallet(): StellarWallet | null {
  if (!cachedWallet) return null;
  if (Date.now() >= cachedWallet.expiresAt) {
    cachedWallet = null;
    return null;
  }
  return cachedWallet.wallet;
}

function cacheWalletForSession(secret: string, ttlMs: number = SESSION_PIN_TTL_MS): StellarWallet {
  const wallet = createWalletObject(secret);
  cachedWallet = { wallet, expiresAt: Date.now() + ttlMs };
  return wallet;
}

// ─── Wallet object factory ────────────────────────────────────────────────────

function createWalletObject(secret: string): StellarWallet {
  const keypair = StellarSdk.Keypair.fromSecret(secret);
  const publicKey = keypair.publicKey();

  return {
    address: publicKey,
    publicKey,
    secret,
    keypair,
    signXdr: (xdr: string, networkPassphrase: string) =>
      signTransactionEnvelopeXdr(xdr, networkPassphrase, keypair),
  };
}

function signTransactionEnvelopeXdr(
  envelopeXdr: string,
  networkPassphrase: string,
  keypair: StellarSdk.Keypair,
): string {
  const envelope = StellarSdk.xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64');
  const envelopeType = envelope.switch();

  if (envelopeType === StellarSdk.xdr.EnvelopeType.envelopeTypeTx()) {
    const txEnvelope = envelope.v1();
    const tx = txEnvelope.tx();
    const signatures = txEnvelope.signatures().slice();
    signatures.push(signTransactionPayload(tx, networkPassphrase, keypair));
    return encodeXdrBase64(
      StellarSdk.xdr.TransactionEnvelope.envelopeTypeTx(
        new StellarSdk.xdr.TransactionV1Envelope({ tx, signatures }),
      ),
    );
  }

  if (envelopeType === StellarSdk.xdr.EnvelopeType.envelopeTypeTxV0()) {
    const txEnvelope = envelope.v0();
    const txV0 = txEnvelope.tx();
    const signatures = txEnvelope.signatures().slice();
    const tx = StellarSdk.xdr.Transaction.fromXDR(
      Buffer.concat([
        (StellarSdk.xdr.PublicKeyType.publicKeyTypeEd25519() as any).toXDR(),
        txV0.toXDR(),
      ]),
    );
    signatures.push(signTransactionPayload(tx, networkPassphrase, keypair));
    return encodeXdrBase64(
      StellarSdk.xdr.TransactionEnvelope.envelopeTypeTxV0(
        new StellarSdk.xdr.TransactionV0Envelope({ tx: txV0, signatures }),
      ),
    );
  }

  throw new Error(`Unsupported transaction envelope type: ${envelopeType.name}`);
}

function signTransactionPayload(
  tx: StellarSdk.xdr.Transaction,
  networkPassphrase: string,
  keypair: StellarSdk.Keypair,
): StellarSdk.xdr.DecoratedSignature {
  const taggedTransaction =
    StellarSdk.xdr.TransactionSignaturePayloadTaggedTransaction.envelopeTypeTx(tx);
  const signaturePayload = new StellarSdk.xdr.TransactionSignaturePayload({
    networkId: StellarSdk.xdr.Hash.fromXDR(StellarSdk.hash(Buffer.from(networkPassphrase, 'utf8'))),
    taggedTransaction,
  });
  const txHash = StellarSdk.hash(signaturePayload.toXDR());
  return keypair.signDecorated(txHash);
}

function encodeXdrBase64(value: { toXDR: () => Buffer | Uint8Array }): string {
  return Buffer.from(value.toXDR()).toString('base64');
}
