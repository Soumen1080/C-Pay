import { supabase } from './supabase';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { clearSessionPin } from './wallet';

// Rate limiting constants
const MAX_OTP_ATTEMPTS_PER_DAY = 10;
const OTP_RATE_LIMIT_KEY = 'otp_rate_limit';

function getRetryHours(resetTime: Date): number {
  return Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / (1000 * 60 * 60)));
}

function isRateLimitMessage(message?: string): boolean {
  if (!message) {
    return false;
  }

  return /rate|limit|too many|security purposes|wait|requested/i.test(message);
}

function getSupabaseEmailSendError(email: string, message?: string): string {
  if (isRateLimitMessage(message)) {
    return `Supabase temporarily blocked another verification email for ${email} or this project. This is not a full app-system block. Try again after 60 seconds. If this message still appears, wait up to 1 hour before requesting another code.`;
  }

  return message || 'Failed to send email OTP';
}

interface OTPRateLimit {
  attempts: number;
  lastAttempt: string; // ISO date string
  resetDate: string; // ISO date string
}

/**
 * Check if user has exceeded OTP rate limit
 */
async function checkRateLimit(): Promise<{
  allowed: boolean;
  remainingAttempts: number;
  resetTime?: Date;
}> {
  try {
    const rateLimitData = await AsyncStorage.getItem(OTP_RATE_LIMIT_KEY);
    const now = new Date();
    
    if (!rateLimitData) {
      return { allowed: true, remainingAttempts: MAX_OTP_ATTEMPTS_PER_DAY };
    }

    const rateLimit: OTPRateLimit = JSON.parse(rateLimitData);
    const resetDate = new Date(rateLimit.resetDate);

    // Check if we need to reset (new day)
    if (now >= resetDate) {
      await AsyncStorage.removeItem(OTP_RATE_LIMIT_KEY);
      return { allowed: true, remainingAttempts: MAX_OTP_ATTEMPTS_PER_DAY };
    }

    // Check if limit exceeded
    if (rateLimit.attempts >= MAX_OTP_ATTEMPTS_PER_DAY) {
      return {
        allowed: false,
        remainingAttempts: 0,
        resetTime: resetDate,
      };
    }

    return {
      allowed: true,
      remainingAttempts: MAX_OTP_ATTEMPTS_PER_DAY - rateLimit.attempts,
    };
  } catch (error) {
    console.error('Error checking rate limit:', error);
    return { allowed: true, remainingAttempts: MAX_OTP_ATTEMPTS_PER_DAY };
  }
}

/**
 * Increment OTP attempt counter
 */
async function incrementAttempt(): Promise<void> {
  try {
    const rateLimitData = await AsyncStorage.getItem(OTP_RATE_LIMIT_KEY);
    const now = new Date();
    
    // Calculate reset time (midnight of next day)
    const resetDate = new Date(now);
    resetDate.setHours(24, 0, 0, 0);

    let rateLimit: OTPRateLimit;

    if (!rateLimitData) {
      rateLimit = {
        attempts: 1,
        lastAttempt: now.toISOString(),
        resetDate: resetDate.toISOString(),
      };
    } else {
      const existing: OTPRateLimit = JSON.parse(rateLimitData);
      rateLimit = {
        attempts: existing.attempts + 1,
        lastAttempt: now.toISOString(),
        resetDate: existing.resetDate,
      };
    }

    await AsyncStorage.setItem(OTP_RATE_LIMIT_KEY, JSON.stringify(rateLimit));
  } catch (error) {
    console.error('Error incrementing attempt:', error);
  }
}


/**
 * Send an email OTP for the current login/onboarding verification flow.
 * This keeps the existing app-level OTP request limit while phone OTP is paused.
 */
export async function sendLoginEmailOTP(email: string): Promise<{
  success: boolean;
  verificationId?: string;
  error?: string;
  remainingAttempts?: number;
  resetTime?: Date;
}> {
  try {
    const rateLimitCheck = await checkRateLimit();

    if (!rateLimitCheck.allowed) {
      const resetTime = rateLimitCheck.resetTime!;
      const hours = getRetryHours(resetTime);
      return {
        success: false,
        error: `This device reached today's verification-code request limit across all email addresses. Try again in ${hours} hour${hours > 1 ? 's' : ''}.`,
        remainingAttempts: 0,
        resetTime,
      };
    }

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
      },
    });

    if (error) {
      return {
        success: false,
        error: getSupabaseEmailSendError(email, error.message),
        remainingAttempts: rateLimitCheck.remainingAttempts,
      };
    }

    await incrementAttempt();

    return {
      success: true,
      verificationId: email,
      remainingAttempts: rateLimitCheck.remainingAttempts - 1,
    };
  } catch (error: any) {
    console.error('Send login email OTP error:', error);
    return {
      success: false,
      error: error.message || 'Failed to send email OTP',
    };
  }
}

/**
 * Verify the email OTP used for login/onboarding verification.
 */
export async function verifyLoginEmailOTP(
  verificationId: string,
  otpCode: string
): Promise<{
  success: boolean;
  email?: string;
  error?: string;
}> {
  try {
    const { data, error } = await supabase.auth.verifyOtp({
      email: verificationId,
      token: otpCode,
      type: 'email',
    });

    if (error) {
      return {
        success: false,
        error: error.message,
      };
    }

    return {
      success: true,
      email: data.user?.email || verificationId,
    };
  } catch (error: any) {
    console.error('Verify login email OTP error:', error);
    return {
      success: false,
      error: error.message || 'Invalid email OTP code',
    };
  }
}


/**
 * Get remaining OTP attempts for the day
 */
export async function getRemainingAttempts(): Promise<{
  remaining: number;
  resetTime?: Date;
}> {
  const rateLimitCheck = await checkRateLimit();
  return {
    remaining: rateLimitCheck.remainingAttempts,
    resetTime: rateLimitCheck.resetTime,
  };
}

/**
 * Sign out from Supabase
 */
export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
  await AsyncStorage.multiRemove([
    'auth_token',
    'phone_verified',
    'phone_number',
    'email_verified',
    'user_email',
  ]);
  clearSessionPin();
}

/**
 * Send OTP to email address (for merchant registration)
 */
export async function sendEmailOTP(email: string): Promise<{
  success: boolean;
  verificationId?: string;
  error?: string;
}> {
  try {
    // Production: Send email OTP via Supabase
    // Note: This requires setting up email templates in Supabase dashboard
    const { error } = await supabase.auth.signInWithOtp({
      email: email,
      options: {
        shouldCreateUser: true,
      }
    });

    if (error) {
      return {
        success: false,
        error: error.message,
      };
    }

    return {
      success: true,
      verificationId: email,
    };
  } catch (error: any) {
    console.error('Send email OTP error:', error);
    return {
      success: false,
      error: error.message || 'Failed to send email OTP',
    };
  }
}

/**
 * Verify email OTP (for merchant registration)
 */
export async function verifyEmailOTP(
  verificationId: string,
  otpCode: string
): Promise<{
  success: boolean;
  email?: string;
  error?: string;
}> {
  try {
    // Production: Verify with Supabase
    const { data, error } = await supabase.auth.verifyOtp({
      email: verificationId,
      token: otpCode,
      type: 'email',
    });

    if (error) {
      return {
        success: false,
        error: error.message,
      };
    }

    return {
      success: true,
      email: data.user?.email || verificationId,
    };
  } catch (error: any) {
    console.error('Verify email OTP error:', error);
    return {
      success: false,
      error: error.message || 'Invalid email OTP code',
    };
  }
}

/**
 * Send a merchant contact email OTP via the relayer's Admin API path.
 * This does NOT call supabase.auth.signInWithOtp — the wallet owner's
 * Supabase session is never modified.
 *
 * Requires a provisional merchantId (from the just-inserted merchants row)
 * and the business contact email to verify.
 */
export async function sendMerchantContactOtp(
  merchantId: string,
  contactEmail: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token;
    if (!accessToken) {
      return { success: false, error: 'No active session — please log in again' };
    }

    const relayerUrl = (process.env.EXPO_PUBLIC_STELLAR_RELAYER_URL || '').replace(/\/+$/, '');
    if (!relayerUrl) {
      return { success: false, error: 'Relayer URL not configured' };
    }

    const response = await fetch(`${relayerUrl}/merchants/send-contact-otp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ merchantId, contactEmail }),
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      return { success: false, error: body?.error || 'Failed to send verification code' };
    }

    return { success: true };
  } catch (error: any) {
    console.error('sendMerchantContactOtp error:', error);
    return { success: false, error: error.message || 'Failed to send verification code' };
  }
}

/**
 * Verify a merchant contact email OTP via the relayer.
 * On success the relayer marks contact_email_verified = true on the merchants
 * row and auto-approves the merchant in pilot mode.
 */
export async function verifyMerchantContactOtp(
  merchantId: string,
  contactEmail: string,
  token: string
): Promise<{ success: boolean; verificationStatus?: string; error?: string }> {
  try {
    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token;
    if (!accessToken) {
      return { success: false, error: 'No active session — please log in again' };
    }

    const relayerUrl = (process.env.EXPO_PUBLIC_STELLAR_RELAYER_URL || '').replace(/\/+$/, '');
    if (!relayerUrl) {
      return { success: false, error: 'Relayer URL not configured' };
    }

    const response = await fetch(`${relayerUrl}/merchants/verify-contact-otp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ merchantId, contactEmail, token }),
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      return { success: false, error: body?.error || 'Invalid or expired verification code' };
    }

    return { success: true, verificationStatus: body?.verificationStatus };
  } catch (error: any) {
    console.error('verifyMerchantContactOtp error:', error);
    return { success: false, error: error.message || 'Failed to verify code' };
  }
}

