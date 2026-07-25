// Mock for expo-crypto
import { randomBytes } from 'crypto';

export const getRandomBytesAsync = jest.fn(async (byteCount: number): Promise<Uint8Array> => {
  return new Uint8Array(randomBytes(byteCount));
});
