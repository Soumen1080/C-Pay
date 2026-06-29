import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Share,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import ViewShot from 'react-native-view-shot';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Sharing from 'expo-sharing';
import * as MediaLibrary from 'expo-media-library';
import * as Clipboard from 'expo-clipboard';
import { getMerchantProfile } from '../services/merchant';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS } from '../constants/theme';
import { Screen, Header, MerchantQRCard, MerchantQRActions } from '../components';
import { AlertManager } from '../utils/alert';
import { formatWalletFingerprint, getCurrentMerchantCPayId } from '../utils/cpayId';
import { generatePaymentQRWithId } from '../utils/qrCode';
import { getMediaLibraryDownloadErrorMessage, requestPhotoSavePermission } from '../utils/mediaLibrary';

const FONT_SIZES = TYPOGRAPHY.sizes;

interface MerchantGlobalQRScreenProps {
  navigation: any;
}

export const MerchantGlobalQRScreen: React.FC<MerchantGlobalQRScreenProps> = ({
  navigation,
}) => {
  const [loading, setLoading] = useState(true);
  const [qrValue, setQRValue] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [walletAddress, setWalletAddress] = useState('');
  const [cpayId, setCpayId] = useState('');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const viewShotRef = useRef<ViewShot>(null);

  useEffect(() => {
    loadMerchantQR();
  }, []);

  const loadMerchantQR = async () => {
    try {
      const address = await AsyncStorage.getItem('wallet_address');
      if (!address) {
        AlertManager.alert('Error', 'Wallet address not found');
        return;
      }

      const profile = await getMerchantProfile(address);
      if (profile) {
        // Gate: unapproved merchants cannot show QR codes
        const status = profile.verification_status || 'pending';
        if (status !== 'approved') {
          AlertManager.alert(
            'Not Yet Approved',
            status === 'rejected'
              ? 'Your merchant account was not approved. QR payments are disabled. Please contact support.'
              : 'Your merchant account is still under review. QR payments will be enabled once approved.',
            [{ text: 'OK', onPress: () => navigation.goBack() }]
          );
          setLoading(false);
          return;
        }

        setBusinessName(profile.business_name);
        setWalletAddress(address);
        
        // Load Merchant C-Pay ID from merchants table
        const id = await getCurrentMerchantCPayId();
        if (id) {
          setCpayId(id);
        }
        
        if (profile.logo_url && profile.logo_url !== 'default-merchant-logo') {
          setLogoUrl(profile.logo_url);
        }

        const qrData = generatePaymentQRWithId(
          profile.id || address,
          '0',
          profile.business_name,
          address,
          ''
        );

        setQRValue(qrData);
      }
    } catch (error) {
      console.error('Error loading merchant QR:', error);
      AlertManager.alert('Error', 'Failed to load merchant QR code');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyAddress = async () => {
    await Clipboard.setStringAsync(cpayId || formatWalletFingerprint(walletAddress));
    // Silent copy - no alert
  };

  const handleShare = async () => {
    try {
      await Share.share({
        message: `Pay ${businessName}\nC-Pay ID: ${cpayId || formatWalletFingerprint(walletAddress)}\n\nScan my QR code in C-Pay app to send payment instantly!`,
      });
    } catch (error) {
      console.error('Error sharing:', error);
    }
  };

  const handleDownloadQR = async () => {
    try {
      if (viewShotRef.current && viewShotRef.current.capture) {
        const uri = await viewShotRef.current.capture();
        const filename = `${businessName.replace(/\s+/g, '_')}_QR.png`;
        
        // Request permission to save to media library
        const hasPermission = await requestPhotoSavePermission();
        if (!hasPermission) {
          AlertManager.alert('Permission Required', 'Please grant permission to save images to your device');
          return;
        }

        // Save to media library
        await MediaLibrary.saveToLibraryAsync(uri);
        AlertManager.alert('Success', 'QR Code saved to your gallery!');
      }
    } catch (error) {
      console.error('Error downloading QR:', error);
      AlertManager.alert('Error', getMediaLibraryDownloadErrorMessage(error));
    }
  };

  const handleShareQRImage = async () => {
    try {
      if (viewShotRef.current && viewShotRef.current.capture) {
        const uri = await viewShotRef.current.capture();
        
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(uri, {
            mimeType: 'image/png',
            dialogTitle: `Share ${businessName} QR Code`,
          });
        }
      }
    } catch (error) {
      console.error('Error sharing QR image:', error);
      AlertManager.alert('Error', 'Failed to share QR code');
    }
  };

  return (
    <Screen
      loading={loading}
      header={
        <Header
          title="My Payment QR"
          onBack={() => navigation.goBack()}
          actions={[{ icon: 'share-outline', onPress: handleShare, accessibilityLabel: 'Share payment QR' }]}
        />
      }
    >
      {/* Shared merchant QR card */}
      <ViewShot ref={viewShotRef} options={{ format: 'png', quality: 1.0 }}>
        <MerchantQRCard
          businessName={businessName}
          qrValue={qrValue}
          logoUrl={logoUrl}
          footerText="Show this QR code to receive payments"
          onLogoError={() => setLogoUrl(null)}
        />
      </ViewShot>

      <MerchantQRActions
        style={styles.actionsRow}
        onShare={handleShareQRImage}
        onDownload={handleDownloadQR}
      />

      {/* C-Pay ID */}
      <View style={styles.walletCard}>
        <Text style={styles.walletLabel}>C-Pay ID</Text>
        <TouchableOpacity
          style={styles.walletAddressContainer}
          onPress={handleCopyAddress}
        >
          <Text style={styles.walletAddress} numberOfLines={1}>
            {cpayId || formatWalletFingerprint(walletAddress)}
          </Text>
          <Ionicons name="copy-outline" size={20} color={COLORS.primary} />
        </TouchableOpacity>
      </View>
    </Screen>
  );
};

const styles = StyleSheet.create({
  actionsRow: {
    marginTop: SPACING.lg,
  },
  walletCard: {
    backgroundColor: COLORS.surface,
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.lg,
    marginTop: SPACING.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  walletLabel: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    marginBottom: SPACING.xs,
  },
  walletAddressContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  walletAddress: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.text,
    fontFamily: 'monospace',
    flex: 1,
    marginRight: SPACING.sm,
  },
});
