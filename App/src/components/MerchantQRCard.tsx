import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, FONT_SIZES, BORDER_RADIUS, SHADOWS } from '../constants/theme';
import { A11Y } from '../utils/strings';

const DEFAULT_MERCHANT_LOGO = require('../../assets/default-merchant-image-cryptopay.png');
const APP_LOGO = require('../../assets/cpay_logo.png');

export interface MerchantQRCardProps {
  businessName: string;
  qrValue: string;
  logoUrl?: string | null;
  /** Formatted amount shown under the code for fixed-amount QRs. */
  amountLabel?: string;
  /** Caption under the code. */
  footerText?: string;
  size?: number;
  onLogoError?: () => void;
}

/**
 * The single, shared merchant QR card used by both the "show my QR"
 * (MerchantGlobalQR) and "create payment QR" (MerchantQRGenerator) screens, so
 * every QR the merchant displays/exports looks identical. Render it inside a
 * ViewShot to capture for share/download.
 */
export const MerchantQRCard: React.FC<MerchantQRCardProps> = ({
  businessName,
  qrValue,
  logoUrl,
  amountLabel,
  footerText = 'Scan with C-Pay to pay',
  size = 220,
  onLogoError,
}) => {
  const name = businessName || 'Merchant';

  return (
    <View style={styles.card}>
      <View style={styles.identity}>
        <Image
          source={logoUrl ? { uri: logoUrl } : DEFAULT_MERCHANT_LOGO}
          style={styles.logo}
          onError={onLogoError}
          accessible
          accessibilityLabel={A11Y.MERCHANT_LOGO(name)}
          accessibilityRole="image"
        />
        <Text style={styles.businessName} numberOfLines={2}>
          {name}
        </Text>
      </View>

      {/* QR code: treat as a single accessible image so screen readers
          announce it as a scannable QR code rather than reading individual
          SVG paths. */}
      <View
        style={styles.qrBox}
        accessible
        accessibilityLabel={A11Y.MERCHANT_QR_CODE(name)}
        accessibilityRole="image"
      >
        {!!qrValue && (
          <QRCode
            value={qrValue}
            size={size}
            logo={APP_LOGO}
            logoSize={44}
            logoBackgroundColor="white"
            logoMargin={2}
          />
        )}
      </View>

      {!!amountLabel && (
        <View style={styles.amountChip}>
          <Text style={styles.amountChipText}>{amountLabel}</Text>
        </View>
      )}

      <View
        style={styles.footer}
        // Decorative footer row; the parent accessibilityLabel covers it.
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        <Ionicons name="scan-outline" size={14} color={COLORS.textSecondary} />
        <Text style={styles.footerText}>{footerText}</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.xl,
    padding: SPACING.xl,
    alignItems: 'center',
    ...SHADOWS.sm,
  },
  identity: {
    alignItems: 'center',
    marginBottom: SPACING.lg,
  },
  logo: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 2,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    marginBottom: SPACING.sm,
  },
  businessName: {
    fontSize: FONT_SIZES.xl,
    fontWeight: '700',
    color: COLORS.text,
    textAlign: 'center',
  },
  qrBox: {
    backgroundColor: '#FFFFFF',
    padding: SPACING.lg,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.borderLight,
  },
  amountChip: {
    marginTop: SPACING.lg,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.full,
    backgroundColor: COLORS.primaryLight,
  },
  amountChipText: {
    fontSize: FONT_SIZES.xl,
    fontWeight: '800',
    color: COLORS.primaryDark,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    marginTop: SPACING.lg,
  },
  footerText: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
  },
});
