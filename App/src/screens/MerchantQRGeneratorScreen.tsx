import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Image,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import ViewShot from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import * as MediaLibrary from 'expo-media-library';
import { Ionicons } from '@expo/vector-icons';
import { getMerchantProfile } from '../services/merchant';
import { MONEY_UNIT_LABEL, convertINRtoAsset, formatMoneyAmount } from '../utils/currency';
import { generateSignedQRPayload } from '../utils/qrCode';
import { supabase } from '../services/supabase';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS } from '../constants/theme';
import { Screen, Header, AmountInput, Button, MerchantQRCard, MerchantQRActions } from '../components';
import { AlertManager } from '../utils/alert';
import { getMediaLibraryDownloadErrorMessage, requestPhotoSavePermission } from '../utils/mediaLibrary';

const FONT_SIZES = TYPOGRAPHY.sizes;
const DEFAULT_MERCHANT_LOGO = require('../../assets/default-merchant-image-cryptopay.png');

interface MerchantQRGeneratorScreenProps {
  navigation: any;
}

export const MerchantQRGeneratorScreen: React.FC<MerchantQRGeneratorScreenProps> = ({
  navigation,
}) => {
  const [businessName, setBusinessName] = useState('');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [generatedQR, setGeneratedQR] = useState<boolean>(false);
  const [qrValue, setQRValue] = useState('');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [merchantId, setMerchantId] = useState<string | null>(null);
  const viewShotRef = useRef<ViewShot>(null);

  useEffect(() => {
    loadMerchantInfo();
  }, []);

  const loadMerchantInfo = async () => {
    try {
      const walletAddress = await AsyncStorage.getItem('wallet_address');
      if (walletAddress) {
        const profile = await getMerchantProfile(walletAddress);
        if (profile) {
          // Gate: unapproved merchants cannot generate QR codes
          const status = profile.verification_status || 'pending';
          if (status !== 'approved') {
            AlertManager.alert(
              'Not Yet Approved',
              status === 'rejected'
                ? 'Your merchant account was not approved. QR generation is disabled. Please contact support.'
                : 'Your merchant account is still under review. QR generation will be available once approved.',
              [{ text: 'OK', onPress: () => navigation.goBack() }]
            );
            setInitialLoading(false);
            return;
          }
          setMerchantId(profile.id || null);
          setBusinessName(profile.business_name);
          if (profile.logo_url && profile.logo_url !== 'default-merchant-logo') {
            setLogoUrl(profile.logo_url);
          }
        }
      }
    } catch (error) {
      console.error('Error loading merchant info:', error);
    } finally {
      setInitialLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!businessName.trim()) {
      AlertManager.alert('Error', 'Business name not found. Please try again.');
      return;
    }

    const amountNum = amount ? parseFloat(amount) : undefined;
    if (amount && (isNaN(amountNum!) || amountNum! <= 0)) {
      AlertManager.alert('Error', 'Please enter a valid amount');
      return;
    }

    const assetAmount = amountNum ? convertINRtoAsset(amountNum) : undefined;

    try {
      setLoading(true);

      let resolvedMerchantId = merchantId || await AsyncStorage.getItem('merchant_id');
      const walletAddress = await AsyncStorage.getItem('wallet_address');

      if (!resolvedMerchantId && walletAddress) {
        const profile = await getMerchantProfile(walletAddress);
        resolvedMerchantId = profile?.id || null;
        if (profile) {
          setMerchantId(profile.id || null);
          setBusinessName(profile.business_name);
        }
      }

      if (!resolvedMerchantId || !walletAddress) {
        AlertManager.alert('Error', 'Merchant information not found');
        return;
      }

      // Obtain current session token so the relayer can sign the QR payload.
      const { data: sessionData } = await supabase.auth.getSession();
      const bearerToken = sessionData.session?.access_token ?? '';

      const qrData = await generateSignedQRPayload(
        resolvedMerchantId,
        assetAmount ? assetAmount.toFixed(2) : '0',
        businessName,
        walletAddress,
        bearerToken,
        ''
      );

      setQRValue(qrData);
      setGeneratedQR(true);
    } catch (error: any) {
      AlertManager.alert('Error', error.message || 'Failed to generate QR code');
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setAmount('');
    setGeneratedQR(false);
    setQRValue('');
  };

  const handleDownload = async () => {
    if (!viewShotRef.current || !viewShotRef.current.capture) return;
    
    try {
      const uri = await viewShotRef.current.capture();
      
      // Request permission to save to media library
      const hasPermission = await requestPhotoSavePermission();
      if (!hasPermission) {
        AlertManager.alert('Permission Required', 'Please grant permission to save images to your device');
        return;
      }

      // Save to media library
      await MediaLibrary.saveToLibraryAsync(uri);
      AlertManager.alert('Success', 'QR code saved to your gallery!');
    } catch (error) {
      console.error('Error downloading QR:', error);
      AlertManager.alert('Error', getMediaLibraryDownloadErrorMessage(error));
    }
  };

  const handleShare = async () => {
    if (!viewShotRef.current || !viewShotRef.current.capture) return;
    
    try {
      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) {
        AlertManager.alert('Error', 'Sharing is not available on this device');
        return;
      }

      const uri = await viewShotRef.current.capture();
      await Sharing.shareAsync(uri, {
        mimeType: 'image/png',
        dialogTitle: 'Share Payment QR Code',
      });
    } catch (error) {
      console.error('Error sharing QR:', error);
      AlertManager.alert('Error', 'Failed to share QR code');
    }
  };

  return (
    <Screen header={<Header title="Generate QR Code" onBack={() => navigation.goBack()} />}>
        {!generatedQR && (
          <View style={styles.header}>
            {logoUrl ? (
              <Image source={{ uri: logoUrl }} style={styles.headerLogo} onError={() => setLogoUrl(null)} />
            ) : (
              <Image source={DEFAULT_MERCHANT_LOGO} style={styles.headerLogo} />
            )}
            <Text style={styles.title}>Create Payment QR</Text>
            <Text style={styles.subtitle}>
              Generate a QR code for your customers to scan
            </Text>
          </View>
        )}

        {!generatedQR ? (
          <View style={styles.form}>
            {initialLoading ? (
              <ActivityIndicator size="small" color={COLORS.primary} />
            ) : (
              <>
                <View style={styles.businessNameCard}>
                  <Text style={styles.businessNameLabel}>Business Name</Text>
                  <Text style={styles.businessNameValue}>{businessName}</Text>
                </View>

                <AmountInput
                  containerStyle={styles.inputGroup}
                  label="Amount to request"
                  value={amount}
                  onChangeText={setAmount}
                  helper={`Amount in ${MONEY_UNIT_LABEL}. Leave blank for an open QR the customer fills in.`}
                />

                <Button
                  title="Generate QR Code"
                  onPress={handleGenerate}
                  variant="primary"
                  size="lg"
                  fullWidth
                  loading={loading}
                  disabled={loading}
                />
              </>
            )}
          </View>
        ) : (
          <ViewShot ref={viewShotRef} options={{ format: 'png', quality: 1.0 }}>
            <MerchantQRCard
              businessName={businessName}
              qrValue={qrValue}
              logoUrl={logoUrl}
              amountLabel={amount && parseFloat(amount) > 0 ? formatMoneyAmount(parseFloat(amount)) : undefined}
              footerText={amount && parseFloat(amount) > 0 ? 'Scan with C-Pay to pay' : 'Scan with C-Pay — enter any amount'}
              onLogoError={() => setLogoUrl(null)}
            />
          </ViewShot>
        )}

        {generatedQR && (
          <View style={styles.actionsContainer}>
            <MerchantQRActions
              style={styles.actionsRow}
              onShare={handleShare}
              onDownload={handleDownload}
              onNew={resetForm}
            />

            <View style={styles.instructionsBox}>
              <View style={styles.instructionsTitleRow}>
                <Ionicons name="information-circle-outline" size={18} color={COLORS.primary} />
                <Text style={styles.instructionsTitle}>How to use</Text>
              </View>
              <Text style={styles.instructionsText}>
                1. Display this QR code at your store or online
              </Text>
              <Text style={styles.instructionsText}>
                2. Customers scan with C-Pay app
              </Text>
              <Text style={styles.instructionsText}>
                3. Payment goes directly to your wallet
              </Text>
              <Text style={styles.instructionsText}>
                4. Track all payments in your dashboard
              </Text>
            </View>

            <Button
              title="Done"
              onPress={() => navigation.navigate('MerchantDashboard')}
              variant="primary"
              size="lg"
              fullWidth
            />
          </View>
        )}
    </Screen>
  );
};

const styles = StyleSheet.create({
  header: {
    alignItems: 'center',
    marginBottom: SPACING.xl,
  },
  headerLogo: {
    width: 80,
    height: 80,
    borderRadius: 40,
    marginBottom: SPACING.md,
    borderWidth: 2,
    borderColor: COLORS.border,
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
  },
  form: {
  },
  actionsContainer: {
    alignItems: 'center',
  },
  actionsRow: {
    width: '100%',
    marginBottom: SPACING.lg,
  },
  businessNameCard: {
    backgroundColor: COLORS.primary,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md,
    marginBottom: SPACING.lg,
    alignItems: 'center',
  },
  businessNameLabel: {
    fontSize: FONT_SIZES.xs,
    color: COLORS.card,
    opacity: 0.9,
    marginBottom: SPACING.xs,
  },
  businessNameValue: {
    fontSize: FONT_SIZES.lg,
    fontWeight: 'bold',
    color: COLORS.card,
  },
  inputGroup: {
    marginBottom: SPACING.lg,
  },
  instructionsBox: {
    backgroundColor: COLORS.card,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    width: '100%',
    marginBottom: SPACING.lg,
  },
  instructionsTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    marginBottom: SPACING.xs,
  },
  instructionsTitle: {
    fontSize: FONT_SIZES.md,
    fontWeight: '600',
    color: COLORS.text,
  },
  instructionsText: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    marginBottom: SPACING.xs,
  },
});
