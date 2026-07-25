// Mock for expo-secure-store
// Exposes __store so tests can reset it directly with resetStore().

const __store: Record<string, string> = {};

module.exports = {
  __store,
  getItemAsync: jest.fn(async (key: string) => __store[key] ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { __store[key] = value; }),
  deleteItemAsync: jest.fn(async (key: string) => { delete __store[key]; }),
};
