// Mock for the Supabase client used in cpayId.ts and other utilities
// Tests that need specific Supabase responses should override these with jest.fn().mockResolvedValueOnce(...)

export const supabase = {
  from: jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }),
    update: jest.fn().mockReturnThis(),
  })),
  rpc: jest.fn().mockResolvedValue({ data: [], error: null }),
};
