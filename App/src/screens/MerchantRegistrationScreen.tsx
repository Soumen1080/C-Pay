import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Modal,
  Image,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { registerAsMerchant, syncMerchantContract, uploadMerchantLogo } from '../services/merchant';
import { sendMerchantContactOtp, verifyMerchantContactOtp } from '../services/auth';
import { supabase } from '../services/supabase';
import { PINInput } from '../components/PINInput';
import { Screen, Header, FormField, Button, Section, InfoBanner } from '../components';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS } from '../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { AlertManager } from '../utils/alert';

const FONT_SIZES = TYPOGRAPHY.sizes;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MERCHANT_EMAIL_OTP_LENGTH = 8;
const MERCHANT_PHONE_MIN_DIGITS = 10;
const MERCHANT_PHONE_MAX_DIGITS = 15;

const normalizeMerchantPhoneInput = (value: string): string => {
  const hasLeadingPlus = value.trimStart().startsWith('+');
  const digits = value.replace(/\D/g, '').slice(0, MERCHANT_PHONE_MAX_DIGITS);

  return `${hasLeadingPlus ? '+' : ''}${digits}`;
};

interface MerchantRegistrationScreenProps {
  navigation: any;
}

const CATEGORIES = [
  { value: 'food', label: 'Food & Beverage' },
  { value: 'retail', label: 'Retail' },
  { value: 'services', label: 'Services' },
  { value: 'entertainment', label: 'Entertainment' },
  { value: 'education', label: 'Education' },
  { value: 'health', label: 'Health & Wellness' },
  { value: 'technology', label: 'Technology' },
  { value: 'automotive', label: 'Automotive' },
  { value: 'beauty', label: 'Beauty & Salon' },
  { value: 'other', label: 'Other' },
];

export const MerchantRegistrationScreen: React.FC<
  MerchantRegistrationScreenProps
> = ({ navigation }) => {
  const [businessName, setBusinessName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [customCategory, setCustomCategory] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [email, setEmail] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [businessAddress, setBusinessAddress] = useState('');
  const [businessRegistrationNumber, setBusinessRegistrationNumber] = useState('');
  const [logoUri, setLogoUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);
  
  // Email verification states.
  // pendingMerchantId is set after the draft merchant row is created so we can
  // pass it to the relayer OTP endpoints without opening a new auth session.
  const [emailVerified, setEmailVerified] = useState(false);
  const [pendingMerchantId, setPendingMerchantId] = useState('');
  const [emailOTP, setEmailOTP] = useState('');
  const [emailOTPError, setEmailOTPError] = useState('');
  const [showEmailOTPModal, setShowEmailOTPModal] = useState(false);
  const [emailOTPLoading, setEmailOTPLoading] = useState(false);
  
  const handleEmailChange = (text: string) => {
    setEmail(text);
    if (emailVerified) {
      setEmailVerified(false);
    }
    setPendingMerchantId('');
    setEmailOTP('');
    setEmailOTPError('');
  };

  const handleEmailOTPChange = (value: string) => {
    setEmailOTP(value);
    if (emailOTPError) {
      setEmailOTPError('');
    }
  };

  const handlePhoneNumberChange = (value: string) => {
    setPhoneNumber(normalizeMerchantPhoneInput(value));
  };

  const handlePickLogo = async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      
      if (status !== 'granted') {
        AlertManager.alert('Permission Required', 'Please allow access to your photos to select a logo.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.5,
      });

      if (!result.canceled && result.assets[0]) {
        setLogoUri(result.assets[0].uri);
      }
    } catch (error) {
      console.error('Error picking logo:', error);
      AlertManager.alert('Error', 'Failed to select logo');
    }
  };

  const handleSendEmailOTP = async () => {
    const normalizedEmail = email.trim().toLowerCase();

    if (!normalizedEmail) {
      AlertManager.alert('Error', 'Please enter your email address first');
      return;
    }

    if (!EMAIL_REGEX.test(normalizedEmail)) {
      AlertManager.alert('Error', 'Please enter a valid email address');
      return;
    }

    // We need to validate required fields before creating the draft merchant
    // row, because the relayer needs a merchantId to scope the OTP.
    if (!businessName.trim()) {
      AlertManager.alert('Error', 'Please enter your business name before verifying email');
      return;
    }
    if (!ownerName.trim()) {
      AlertManager.alert('Error', 'Please enter the owner name before verifying email');
      return;
    }

    const walletAddress = await AsyncStorage.getItem('wallet_address');
    if (!walletAddress) {
      AlertManager.alert('Error', 'Wallet address not found. Please restart the app.');
      return;
    }

    setEmailOTPLoading(true);
    setEmail(normalizedEmail);
    setEmailOTP('');
    setEmailOTPError('');

    // If we already have a pending draft merchant row, reuse it.
    let merchantId = pendingMerchantId;

    if (!merchantId) {
      // Create a minimal draft merchant row so we can pass merchantId to the
      // relayer. The row will be completed (logo, address, etc.) when the user
      // taps "Register" after OTP verification. We mark it inactive until done.
      const finalCategory = category === 'other' ? customCategory : category;
      const normalizedPhone = normalizeMerchantPhoneInput(phoneNumber);

      const draftResult = await registerAsMerchant({
        business_name: businessName.trim(),
        wallet_address: walletAddress,
        owner_name: ownerName.trim(),
        email: normalizedEmail,
        phone_number: normalizedPhone || undefined,
        business_address: businessAddress.trim() || undefined,
        business_registration_number: businessRegistrationNumber.trim() || undefined,
        description: description.trim() || undefined,
        category: finalCategory || undefined,
        logo_url: 'default-merchant-logo',
        is_active: false, // inactive until fully confirmed
      });

      if (!draftResult.success || !draftResult.merchantId) {
        setEmailOTPLoading(false);
        AlertManager.alert('Error', draftResult.error || 'Could not create merchant draft. Please try again.');
        return;
      }

      merchantId = draftResult.merchantId;
      setPendingMerchantId(merchantId);
    }

    // Now ask the relayer to send the OTP using the Admin API (no session change).
    const result = await sendMerchantContactOtp(merchantId, normalizedEmail);
    setEmailOTPLoading(false);

    if (result.success) {
      setShowEmailOTPModal(true);
    } else {
      AlertManager.alert('Error', result.error || 'Failed to send verification code');
    }
  };

  const handleVerifyEmailOTP = async (code: string = emailOTP) => {
    if (emailOTPLoading) {
      return;
    }

    const otpToVerify = code.replace(/\D/g, '').slice(0, MERCHANT_EMAIL_OTP_LENGTH);
    setEmailOTP(otpToVerify);

    if (otpToVerify.length !== MERCHANT_EMAIL_OTP_LENGTH) {
      setEmailOTPError(`Enter the ${MERCHANT_EMAIL_OTP_LENGTH}-digit code from your email`);
      return;
    }

    if (!pendingMerchantId) {
      setEmailOTPError('Something went wrong — please tap "Send code" again');
      return;
    }

    setEmailOTPError('');
    setEmailOTPLoading(true);
    const result = await verifyMerchantContactOtp(pendingMerchantId, email.trim().toLowerCase(), otpToVerify);
    setEmailOTPLoading(false);

    if (result.success) {
      setEmailVerified(true);
      setShowEmailOTPModal(false);
      setEmailOTP('');
      setEmailOTPError('');
    } else {
      setEmailOTPError(result.error || 'Invalid verification code. Check your email and try again.');
    }
  };

  const handleRegister = async () => {
    // Validation
    if (!businessName.trim()) {
      AlertManager.alert('Error', 'Please enter your business name');
      return;
    }

    if (!ownerName.trim()) {
      AlertManager.alert('Error', 'Please enter the owner/contact person name');
      return;
    }

    if (!email.trim()) {
      AlertManager.alert('Error', 'Please enter a business email');
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();

    if (!EMAIL_REGEX.test(normalizedEmail)) {
      AlertManager.alert('Error', 'Please enter a valid email address');
      return;
    }

    if (!emailVerified) {
      AlertManager.alert('Error', 'Please verify your email address');
      return;
    }

    if (!phoneNumber.trim()) {
      AlertManager.alert('Error', 'Please enter a contact phone number');
      return;
    }

    const normalizedPhone = normalizeMerchantPhoneInput(phoneNumber);
    const phoneDigits = normalizedPhone.replace(/\D/g, '');

    if (phoneDigits.length < MERCHANT_PHONE_MIN_DIGITS || phoneDigits.length > MERCHANT_PHONE_MAX_DIGITS) {
      AlertManager.alert('Error', `Please enter a valid contact phone number (${MERCHANT_PHONE_MIN_DIGITS}-${MERCHANT_PHONE_MAX_DIGITS} digits)`);
      return;
    }

    if (!businessAddress.trim()) {
      AlertManager.alert('Error', 'Please enter your business address');
      return;
    }

    if (!category) {
      AlertManager.alert('Error', 'Please select a business category');
      return;
    }

    if (category === 'other' && !customCategory.trim()) {
      AlertManager.alert('Error', 'Please specify your business category');
      return;
    }

    try {
      setLoading(true);

      const walletAddress = await AsyncStorage.getItem('wallet_address');
      if (!walletAddress) {
        AlertManager.alert('Error', 'Wallet address not found');
        return;
      }

      const finalCategory = category === 'other' ? customCategory : category;

      // Upload logo or use default
      let logoUrl: string | undefined;
      if (logoUri) {
        AlertManager.alert('Uploading', 'Uploading your business logo...');
        const uploadedLogoUrl = await uploadMerchantLogo(logoUri, businessName);
        if (!uploadedLogoUrl) {
          AlertManager.alert('Logo Upload Failed', 'Your logo could not be uploaded. Please check the storage policy and try again.');
          return;
        }
        logoUrl = uploadedLogoUrl;
      } else {
        logoUrl = 'default-merchant-logo';
      }

      let merchantId = pendingMerchantId;

      if (merchantId) {
        // A draft row already exists from the OTP send step — update it to its
        // final state and activate it. This avoids a duplicate-key error on
        // wallet_address and preserves the verified_contact_email already set
        // by the relayer.
        const { error: updateError } = await supabase
          .from('merchants')
          .update({
            business_name: businessName.trim(),
            owner_name: ownerName.trim(),
            email: normalizedEmail,
            phone_number: normalizedPhone,
            business_address: businessAddress.trim(),
            business_registration_number: businessRegistrationNumber.trim() || null,
            description: description.trim() || null,
            category: finalCategory,
            logo_url: logoUrl,
            is_active: true,
            updated_at: new Date().toISOString(),
          })
          .eq('id', merchantId);

        if (updateError) {
          AlertManager.alert('Error', updateError.message || 'Failed to update merchant profile');
          return;
        }

        // Store merchant id locally
        await AsyncStorage.multiSet([
          ['is_merchant', 'true'],
          ['merchant_id', merchantId],
        ]);

        // Sync the contract (may already be done from the draft step)
        const syncResult = await syncMerchantContract(merchantId, walletAddress);
        if (!syncResult.success) {
          AlertManager.alert(
            'Merchant Saved',
            'Your profile is saved, but the on-chain contract sync did not finish. Open your dashboard and tap "Retry" under Business status to finish — QR payments work once it completes.',
            undefined,
            { type: 'warning' }
          );
        }

        navigation.replace('MerchantDashboard');
      } else {
        // No draft row yet — do a full registration (fallback path, e.g. relayer
        // not configured so OTP was skipped).
        const result = await registerAsMerchant({
          business_name: businessName.trim(),
          wallet_address: walletAddress,
          description: description.trim() || undefined,
          category: finalCategory,
          owner_name: ownerName.trim(),
          email: normalizedEmail,
          phone_number: normalizedPhone,
          business_address: businessAddress.trim(),
          business_registration_number: businessRegistrationNumber.trim() || undefined,
          logo_url: logoUrl,
          is_active: true,
        });

        if (result.success) {
          if (result.contractSynced === false) {
            AlertManager.alert(
              'Merchant Saved',
              'Your profile is saved, but the on-chain contract sync did not finish. Open your dashboard and tap "Retry" under Business status to finish — QR payments work once it completes.',
              undefined,
              { type: 'warning' }
            );
          }
          navigation.replace('MerchantDashboard');
        } else {
          AlertManager.alert('Error', result.error || 'Failed to register as merchant');
        }
      }
    } catch (error: any) {
      AlertManager.alert('Error', error.message || 'Failed to register');
    } finally {
      setLoading(false);
    }
  };

  const emailOTPComplete = emailOTP.length === MERCHANT_EMAIL_OTP_LENGTH;

  return (
    <Screen header={<Header title="Merchant Registration" onBack={() => navigation.goBack()} />}>
      <View style={styles.header}>
        <View style={styles.headerIcon}>
          <Ionicons name="storefront-outline" size={40} color={COLORS.primary} />
        </View>
        <Text style={styles.title}>Become a Merchant</Text>
        <Text style={styles.subtitle}>
          Fill in your business details to start accepting payments
        </Text>
      </View>

      <View style={styles.form}>
        {/* Section 1 — Business details */}
        <Section title="Business details" subtitle="How customers will recognise you">
          {/* Business Logo */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Business Logo (Optional)</Text>
            <View style={styles.logoContainer}>
              <TouchableOpacity style={styles.logoButton} onPress={handlePickLogo}>
                {logoUri ? (
                  <Image source={{ uri: logoUri }} style={styles.logoPreview} />
                ) : (
                  <View style={styles.logoPlaceholder}>
                    <Ionicons name="image-outline" size={40} color={COLORS.textSecondary} />
                    <Text style={styles.logoPlaceholderText}>Add Logo</Text>
                  </View>
                )}
              </TouchableOpacity>
              <Text style={styles.logoHint}>
                {logoUri ? 'Tap to change logo' : 'Recommended: Square image, 512x512px or larger'}
              </Text>
            </View>
          </View>

          {/* Business Name */}
          <FormField
            label="Business Name *"
            containerStyle={styles.inputGroup}
            value={businessName}
            onChangeText={setBusinessName}
            placeholder="e.g., Joe's Coffee Shop"
          />

          {/* Category Dropdown */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Business Category *</Text>
            <TouchableOpacity
              style={styles.dropdown}
              onPress={() => setShowCategoryDropdown(true)}
            >
              <Text style={[styles.dropdownText, !category && styles.dropdownPlaceholder]}>
                {category
                  ? CATEGORIES.find(c => c.value === category)?.label || customCategory
                  : 'Select a category'}
              </Text>
              <Ionicons name="chevron-down" size={20} color={COLORS.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Custom Category Input (if "Other" selected) */}
          {category === 'other' && (
            <FormField
              label="Specify Your Category *"
              containerStyle={styles.inputGroup}
              value={customCategory}
              onChangeText={setCustomCategory}
              placeholder="e.g., Pet Services, Agriculture, etc."
            />
          )}

          {/* Description */}
          <FormField
            label="Business Description (Optional)"
            containerStyle={styles.inputGroup}
            value={description}
            onChangeText={setDescription}
            placeholder="Tell customers about your business and services..."
            multiline
          />
        </Section>

        {/* Section 2 — Contact & verification */}
        <Section title="Contact & verification" subtitle="We verify your email before activating payments">
          {/* Owner/Contact Name */}
          <FormField
            label="Owner/Contact Person *"
            containerStyle={styles.inputGroup}
            value={ownerName}
            onChangeText={setOwnerName}
            placeholder="Full name of owner or manager"
          />

          {/* Email */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Business Email *</Text>
            <View style={styles.inputWithButton}>
              <TextInput
                style={[styles.input, styles.inputWithVerify]}
                value={email}
                onChangeText={handleEmailChange}
                placeholder="contact@yourbusiness.com"
                placeholderTextColor={COLORS.textSecondary}
                keyboardType="email-address"
                autoCapitalize="none"
                editable={!emailVerified}
              />
              {emailVerified ? (
                <View style={styles.verifiedBadge}>
                  <Ionicons name="checkmark-circle" size={20} color={COLORS.success} />
                  <Text style={styles.verifiedText}>Verified</Text>
                </View>
              ) : (
                <TouchableOpacity
                  style={[styles.verifyButton, emailOTPLoading && styles.buttonDisabled]}
                  onPress={handleSendEmailOTP}
                  disabled={emailOTPLoading}
                >
                  {emailOTPLoading ? (
                    <ActivityIndicator size="small" color={COLORS.card} />
                  ) : (
                    <Text style={styles.verifyButtonText}>Send code</Text>
                  )}
                </TouchableOpacity>
              )}
            </View>
            {!emailVerified && (
              <Text style={styles.fieldHint}>Required — verify to enable merchant payments.</Text>
            )}
          </View>

          {/* Phone Number */}
          <FormField
            label="Contact Phone Number *"
            containerStyle={styles.inputGroup}
            value={phoneNumber}
            onChangeText={handlePhoneNumberChange}
            placeholder="+1234567890"
            keyboardType="phone-pad"
            maxLength={MERCHANT_PHONE_MAX_DIGITS + 1}
          />

          {/* Business Address */}
          <FormField
            label="Business Address *"
            containerStyle={styles.inputGroup}
            value={businessAddress}
            onChangeText={setBusinessAddress}
            placeholder="Street address, City, State, ZIP"
            multiline
          />

          {/* Business Registration Number (Optional) */}
          <FormField
            label="Business Registration Number (Optional)"
            containerStyle={styles.inputGroup}
            value={businessRegistrationNumber}
            onChangeText={setBusinessRegistrationNumber}
            placeholder="Tax ID or Business License Number"
          />
        </Section>

        <InfoBanner
          variant="info"
          icon="git-network-outline"
          message="After you register, we sync your account to the C-Pay payment contract so your QR codes can accept payments. You can retry the sync from your dashboard if it doesn't finish."
          style={styles.inputGroup}
        />

        <Button
          title="Register as Merchant"
          onPress={handleRegister}
          variant="primary"
          size="lg"
          fullWidth
          loading={loading}
          disabled={loading}
          style={styles.submitButton}
        />
      </View>

      {/* Category Dropdown Modal */}
      <Modal
        visible={showCategoryDropdown}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setShowCategoryDropdown(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowCategoryDropdown(false)}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select Category</Text>
              <TouchableOpacity onPress={() => setShowCategoryDropdown(false)}>
                <Ionicons name="close" size={24} color={COLORS.text} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.categoryList}>
              {CATEGORIES.map((cat) => (
                <TouchableOpacity
                  key={cat.value}
                  style={[
                    styles.categoryOption,
                    category === cat.value && styles.categoryOptionSelected,
                  ]}
                  onPress={() => {
                    setCategory(cat.value);
                    if (cat.value !== 'other') {
                      setCustomCategory('');
                    }
                    setShowCategoryDropdown(false);
                  }}
                >
                  <Text style={styles.categoryOptionText}>{cat.label}</Text>
                  {category === cat.value && (
                    <Ionicons name="checkmark" size={20} color={COLORS.primary} />
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Email OTP Modal */}
      <Modal
        visible={showEmailOTPModal}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setShowEmailOTPModal(false)}
      >
        <View style={styles.otpModalOverlay}>
          <View style={styles.otpModalContent}>
            <View style={styles.otpModalHeader}>
              <Text style={styles.otpModalTitle}>Verify Email</Text>
              <TouchableOpacity onPress={() => {
                setShowEmailOTPModal(false);
                setEmailOTP('');
                setEmailOTPError('');
              }}>
                <Ionicons name="close" size={24} color={COLORS.text} />
              </TouchableOpacity>
            </View>
            <Text style={styles.otpModalSubtitle}>
              Enter the {MERCHANT_EMAIL_OTP_LENGTH}-digit code sent to {email}
            </Text>
            <PINInput
              value={emailOTP}
              onChange={handleEmailOTPChange}
              onComplete={handleVerifyEmailOTP}
              length={MERCHANT_EMAIL_OTP_LENGTH}
              autoFocus
              disabled={emailOTPLoading}
              secure={false}
              accessibilityLabel="Email verification code"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
            />
            {emailOTPError ? (
              <View style={styles.otpErrorRow}>
                <Ionicons name="alert-circle-outline" size={16} color={COLORS.error} />
                <Text style={styles.otpErrorText}>{emailOTPError}</Text>
              </View>
            ) : (
              <Text style={styles.otpHelperText}>
                The code verifies automatically when all {MERCHANT_EMAIL_OTP_LENGTH} digits are entered.
              </Text>
            )}
            <TouchableOpacity
              style={[
                styles.otpVerifyButton,
                (emailOTPLoading || !emailOTPComplete) && styles.buttonDisabled,
              ]}
              onPress={() => handleVerifyEmailOTP()}
              disabled={emailOTPLoading || !emailOTPComplete}
            >
              {emailOTPLoading ? (
                <View style={styles.buttonContent}>
                  <ActivityIndicator color={COLORS.card} size="small" />
                  <Text style={styles.buttonText}>Checking code...</Text>
                </View>
              ) : (
                <Text style={styles.buttonText}>
                  {emailOTPComplete ? 'Verify Email' : `Enter ${MERCHANT_EMAIL_OTP_LENGTH} digits`}
                </Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.resendButton, emailOTPLoading && styles.buttonDisabled]}
              onPress={handleSendEmailOTP}
              disabled={emailOTPLoading}
            >
              <Text style={styles.resendButtonText}>Resend Code</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </Screen>
  );
};

const styles = StyleSheet.create({
  header: {
    alignItems: 'center',
    marginBottom: SPACING.xl,
  },
  headerIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: COLORS.primary + '14',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SPACING.md,
  },
  title: {
    fontSize: FONT_SIZES.xxl,
    fontWeight: '800',
    color: COLORS.text,
    marginBottom: SPACING.xs,
  },
  subtitle: {
    fontSize: FONT_SIZES.md,
    color: COLORS.textSecondary,
    textAlign: 'center',
    paddingHorizontal: SPACING.lg,
  },
  form: {
  },
  inputGroup: {
    marginBottom: SPACING.lg,
  },
  label: {
    fontSize: FONT_SIZES.md,
    fontWeight: '600',
    color: COLORS.text,
    marginBottom: SPACING.sm,
  },
  fieldHint: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    marginTop: SPACING.xs,
  },
  input: {
    backgroundColor: COLORS.card,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md,
    fontSize: FONT_SIZES.md,
    color: COLORS.text,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  textArea: {
    height: 80,
    textAlignVertical: 'top',
  },
  dropdown: {
    backgroundColor: COLORS.card,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dropdownText: {
    fontSize: FONT_SIZES.md,
    color: COLORS.text,
    flex: 1,
  },
  dropdownPlaceholder: {
    color: COLORS.textSecondary,
  },
  submitButton: {
    marginTop: SPACING.md,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    fontSize: FONT_SIZES.lg,
    fontWeight: '600',
    color: COLORS.card,
  },
  buttonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
  },
  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: COLORS.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '70%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: SPACING.lg,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  modalTitle: {
    fontSize: FONT_SIZES.lg,
    fontWeight: '600',
    color: COLORS.text,
  },
  categoryList: {
    maxHeight: 400,
  },
  categoryOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: SPACING.lg,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  categoryOptionSelected: {
    backgroundColor: COLORS.primary + '10',
  },
  categoryOptionText: {
    fontSize: FONT_SIZES.md,
    color: COLORS.text,
    flex: 1,
  },
  logoContainer: {
    alignItems: 'center',
    gap: SPACING.sm,
  },
  logoButton: {
    width: 150,
    height: 150,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: COLORS.border,
    borderStyle: 'dashed',
  },
  logoPreview: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  logoPlaceholder: {
    width: '100%',
    height: '100%',
    backgroundColor: COLORS.card,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
  },
  logoPlaceholderText: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    marginTop: SPACING.xs,
  },
  logoHint: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    textAlign: 'center',
    paddingHorizontal: SPACING.md,
  },
  inputWithButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  inputWithVerify: {
    flex: 1,
  },
  verifyButton: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm + 2,
    borderRadius: BORDER_RADIUS.md,
    minWidth: 92,
    alignItems: 'center',
  },
  verifyButtonText: {
    color: COLORS.card,
    fontSize: FONT_SIZES.sm,
    fontWeight: '600',
  },
  verifiedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    backgroundColor: COLORS.successBg,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.md,
  },
  verifiedText: {
    color: COLORS.success,
    fontSize: FONT_SIZES.sm,
    fontWeight: '600',
  },
  otpModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.lg,
  },
  otpModalContent: {
    backgroundColor: COLORS.background,
    borderRadius: 16,
    padding: SPACING.xl,
    width: '100%',
    maxWidth: 400,
  },
  otpModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.md,
  },
  otpModalTitle: {
    fontSize: FONT_SIZES.xl,
    fontWeight: '700',
    color: COLORS.text,
  },
  otpModalSubtitle: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    marginBottom: SPACING.lg,
    textAlign: 'center',
  },
  otpHelperText: {
    minHeight: 22,
    color: COLORS.textSecondary,
    fontSize: FONT_SIZES.sm,
    textAlign: 'center',
    marginTop: SPACING.md,
    marginBottom: SPACING.md,
  },
  otpErrorRow: {
    minHeight: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
    marginTop: SPACING.md,
    marginBottom: SPACING.md,
    paddingHorizontal: SPACING.sm,
  },
  otpErrorText: {
    flexShrink: 1,
    color: COLORS.error,
    fontSize: FONT_SIZES.sm,
    fontWeight: '600',
    textAlign: 'center',
  },
  otpVerifyButton: {
    backgroundColor: COLORS.primary,
    borderRadius: 12,
    padding: SPACING.md,
    alignItems: 'center',
    marginBottom: SPACING.sm,
  },
  resendButton: {
    padding: SPACING.sm,
    alignItems: 'center',
  },
  resendButtonText: {
    color: COLORS.primary,
    fontSize: FONT_SIZES.sm,
    fontWeight: '600',
  },
});
