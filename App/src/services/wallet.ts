import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import * as StellarSdk from '@stellar/stellar-base';
import { Buffer } from 'buffer';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8 } from '@noble/ciphers/utils';
import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';

const WALLET_KEY = 'cpay_stellar_wallet';
const PIN_KEY = 'cpay_pin_hash';
const SALT_KEY = 'cpay_pin_salt';
const BIOMETRIC_BACKUP_KEY = 'cpay_stellar_biometric_backup';
const BIOMETRIC_BACKUP_AVAILABLE_KEY = 'cpay_stellar_biometric_backup_available';

const WALLET_STORAGE_VERSION = 4;
const PIN_VERIFIER_VERSION = 2;
const LEGACY_PIN_KDF_ITERATIONS = 120000;
const PIN_KDF_ITERATIONS = 20000;
const WALLET_KDF_ITERATIONS = 80000;
const SESSION_PIN_TTL_MS = 15 * 60 * 1000;
/** How long the wallet stays unlocked after authentication, in minutes. */
export const SESSION_TIMEOUT_MINUTES = Math.round(SESSION_PIN_TTL_MS / 60000);

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

export type StellarWallet = {
  address: string;
  publicKey: string;
  secret: string;
  keypair: StellarSdk.Keypair;
  signXdr: (xdr: string, networkPassphrase: string) => string;
};

let cachedPinHash: string | null = null;
let cachedPin: CachedPin | null = null;
let cachedWallet: CachedWallet | null = null;

type VerifyPinOptions = {
  migrate?: boolean;
  blockMigration?: boolean;
};

export function cachePinForSession(pin: string, ttlMs: number = SESSION_PIN_TTL_MS): void {
  cachedPin = {
    pin,
    expiresAt: Date.now() + ttlMs,
  };
}

export function clearSessionPin(): void {
  cachedPin = null;
  cachedWallet = null;
}

function getCachedPin(): string | null {
  if (!cachedPin) {
    return null;
  }

  if (Date.now() >= cachedPin.expiresAt) {
    cachedPin = null;
    return null;
  }

  return cachedPin.pin;
}

export async function getWalletFromSession(): Promise<StellarWallet | null> {
  const wallet = getCachedWallet();
  if (wallet) {
    return wallet;
  }

  const pin = getCachedPin();
  if (!pin) {
    return null;
  }

  return getWallet(pin);
}

export async function createWallet(pin: string): Promise<string> {
  const keypair = StellarSdk.Keypair.random();
  const publicKey = keypair.publicKey();
  const secret = keypair.secret();

  await Promise.all([
    storeSecret(secret, pin),
    storePinVerifier(pin),
  ]);
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
    if (!secret) {
      return null;
    }

    cachePinForSession(pin);
    return cacheWalletForSession(secret);
  } catch (error) {
    console.error('Error getting wallet:', error);
    return null;
  }
}

export async function getWalletFromBiometricBackup(
  authenticationPrompt: string = 'Unlock wallet'
): Promise<StellarWallet | null> {
  const secret = await recoverWalletWithBiometric(authenticationPrompt);
  if (!secret) {
    return null;
  }

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

    if (!storedPinVerifier || !saltHex) {
      return false;
    }

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
  if (!isValidOldPin) {
    throw new Error('Invalid current PIN');
  }

  const secret = await readSecret(oldPin);
  if (!secret) {
    throw new Error('Wallet not found');
  }

  await SecureStore.deleteItemAsync(SALT_KEY);
  await storeSecret(secret, newPin);
  await storePinVerifier(newPin);
  cachePinForSession(newPin);
  cacheWalletForSession(secret);
}

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

  return {
    hash: stored,
    kdfIterations: LEGACY_PIN_KDF_ITERATIONS,
    needsMigration: true,
  };
}

async function hashPinWithSalt(pin: string, saltHex: string, iterations: number): Promise<string> {
  const verifier = await pbkdf2Async(
    sha256,
    utf8ToBytes(`pin-verifier:${pin}`),
    hexToBytes(saltHex),
    { c: iterations, dkLen: 32 }
  );

  return bytesToHex(verifier);
}

async function deriveWalletKey(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  return pbkdf2Async(
    sha256,
    utf8ToBytes(`wallet-secret:${pin}`),
    salt,
    { c: iterations, dkLen: 32 }
  );
}

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
  if (!stored) {
    return null;
  }

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

    if (StellarSdk.StrKey.isValidEd25519SecretSeed(secret)) {
      return secret;
    }
  } catch (error) {
    console.error('Wallet decrypt failed:', error);
    return null;
  }

  return null;
}

async function storeBiometricBackup(
  secret: string,
  authenticationPrompt: string = 'Secure wallet recovery'
): Promise<boolean> {
  const wallet = createWalletObject(secret);
  const payload: StoredBiometricPayload = {
    version: 1,
    publicKey: wallet.publicKey,
    secret,
    updatedAt: new Date().toISOString(),
  };

  try {
    await SecureStore.setItemAsync(
      BIOMETRIC_BACKUP_KEY,
      JSON.stringify(payload),
      {
        requireAuthentication: true,
        authenticationPrompt,
      }
    );
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
  secretOverride?: string
): Promise<boolean> {
  const wallet = secretOverride ? null : await getWalletFromSession();
  const secret = secretOverride || wallet?.secret;

  if (!secret) {
    throw new Error('Unlock with PIN before enabling biometric authentication');
  }

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
    cachedPinHash = null;
    clearSessionPin();
  } catch (error) {
    console.error('Error clearing wallet:', error);
  }
}

export async function recoverWalletWithBiometric(
  authenticationPrompt: string = 'Unlock wallet to reset PIN'
): Promise<string | null> {
  try {
    const stored = await SecureStore.getItemAsync(
      BIOMETRIC_BACKUP_KEY,
      {
        authenticationPrompt,
        requireAuthentication: true,
      }
    );

    if (!stored) {
      return null;
    }

    const secret = parseBiometricSecret(stored);
    if (!secret) {
      throw new Error('Invalid wallet backup');
    }

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
    if (StellarSdk.StrKey.isValidEd25519SecretSeed(stored)) {
      return stored;
    }
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
  if (!StellarSdk.StrKey.isValidEd25519SecretSeed(secret)) {
    throw new Error('Invalid wallet backup');
  }

  const wallet = createWalletObject(secret);
  await storeSecret(secret, newPin);
  await SecureStore.deleteItemAsync(SALT_KEY);
  await storePinVerifier(newPin);
  cachePinForSession(newPin);
  cacheWalletForSession(secret);
  return wallet.publicKey;
}

function getCachedWallet(): StellarWallet | null {
  if (!cachedWallet) {
    return null;
  }

  if (Date.now() >= cachedWallet.expiresAt) {
    cachedWallet = null;
    return null;
  }

  return cachedWallet.wallet;
}

function cacheWalletForSession(secret: string, ttlMs: number = SESSION_PIN_TTL_MS): StellarWallet {
  const wallet = createWalletObject(secret);
  cachedWallet = {
    wallet,
    expiresAt: Date.now() + ttlMs,
  };

  return wallet;
}

function createWalletObject(secret: string): StellarWallet {
  const keypair = StellarSdk.Keypair.fromSecret(secret);
  const publicKey = keypair.publicKey();

  return {
    address: publicKey,
    publicKey,
    secret,
    keypair,
    signXdr: (xdr: string, networkPassphrase: string) => {
      return signTransactionEnvelopeXdr(xdr, networkPassphrase, keypair);
    },
  };
}

function signTransactionEnvelopeXdr(
  envelopeXdr: string,
  networkPassphrase: string,
  keypair: StellarSdk.Keypair
): string {
  const envelope = StellarSdk.xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64');
  const envelopeType = envelope.switch();

  if (envelopeType === StellarSdk.xdr.EnvelopeType.envelopeTypeTx()) {
    const txEnvelope = envelope.v1();
    const tx = txEnvelope.tx();
    const signatures = txEnvelope.signatures().slice();

    signatures.push(signTransactionPayload(tx, networkPassphrase, keypair));

    return encodeXdrBase64(
      StellarSdk.xdr.TransactionEnvelope
        .envelopeTypeTx(new StellarSdk.xdr.TransactionV1Envelope({ tx, signatures }))
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
      ])
    );

    signatures.push(signTransactionPayload(tx, networkPassphrase, keypair));

    return encodeXdrBase64(
      StellarSdk.xdr.TransactionEnvelope
        .envelopeTypeTxV0(new StellarSdk.xdr.TransactionV0Envelope({ tx: txV0, signatures }))
    );
  }

  throw new Error(`Unsupported transaction envelope type: ${envelopeType.name}`);
}

function signTransactionPayload(
  tx: StellarSdk.xdr.Transaction,
  networkPassphrase: string,
  keypair: StellarSdk.Keypair
): StellarSdk.xdr.DecoratedSignature {
  const taggedTransaction = StellarSdk.xdr.TransactionSignaturePayloadTaggedTransaction.envelopeTypeTx(tx);
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
