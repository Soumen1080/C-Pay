import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getMerchantProfile,
  getMerchantAnalytics,
  getMerchantTransactions,
  getContractSyncState,
  syncMerchantContract,
  merchantEvents,
  type MerchantTransaction,
} from '../services/merchant';
import { COLORS, SPACING, TYPOGRAPHY, BORDER_RADIUS, SHADOWS } from '../constants/theme';
import { formatMoneyBalance } from '../utils/currency';
import { formatDateShort } from '../utils/date';
import { TransactionDetailModal, Screen, Header, Section, ActionRow, Button } from '../components';
import type { TransactionDetail } from '../components/TransactionDetailModal';
import { formatWalletFingerprint, getCPayIdByWallet } from '../utils/cpayId';
import { formatTransactionHash } from '../services/blockchain';
import { AlertManager } from '../utils/alert';

const FONT_SIZES = TYPOGRAPHY.sizes;
const DEFAULT_MERCHANT_LOGO = require('../../assets/default-merchant-image-cryptopay.png');

const TX_STATUS = {
  success: { label: 'Confirmed', color: COLORS.success, bg: COLORS.successBg },
  pending: { label: 'Pending', color: COLORS.warning, bg: COLORS.warningBg },
  failed: { label: 'Failed', color: COLORS.error, bg: COLORS.errorBg },
} as const;

// Helper component to display sender info with C-Pay ID
const SenderInfo: React.FC<{ fromAddress: string; senderName?: string }> = ({ fromAddress, senderName }) => {
  const [displayName, setDisplayName] = React.useState(senderName || 'Loading...');

  React.useEffect(() => {
    const loadName = async () => {
      if (senderName) {
        setDisplayName(senderName);
      } else {
        const cpayId = await getCPayIdByWallet(fromAddress);
        setDisplayName(cpayId || formatWalletFingerprint(fromAddress));
      }
    };
    loadName();
  }, [fromAddress, senderName]);

  return (
    <Text style={styles.transactionFrom} numberOfLines={1}>
      From: {displayName}
    </Text>
  );
};

interface MerchantDashboardScreenProps {
  navigation: any;
}

export const MerchantDashboardScreen: React.FC<
  MerchantDashboardScreenProps
> = ({ navigation }) => {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [businessName, setBusinessName] = useState('');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState('');
  const [merchantId, setMerchantId] = useState<string | null>(null);
  const [verificationStatus, setVerificationStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [rejectionReason, setRejectionReason] = useState<string | null>(null);
  const [contractSynced, setContractSynced] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [totalRevenue, setTotalRevenue] = useState('0');
  const [totalTransactions, setTotalTransactions] = useState(0);
  const [successCount, setSuccessCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [recentTransactions, setRecentTransactions] = useState<MerchantTransaction[]>([]);
  const [selectedTransaction, setSelectedTransaction] = useState<TransactionDetail | null>(null);
  const [showTransactionModal, setShowTransactionModal] = useState(false);

  useEffect(() => {
    loadDashboard();
  }, []);

  const loadDashboard = async () => {
    try {
      const wallet = await AsyncStorage.getItem('wallet_address');
      if (!wallet) return;

      setWalletAddress(wallet);
      setContractSynced(await getContractSyncState());

      // Load merchant profile
      const profile = await getMerchantProfile(wallet);
      let resolvedMerchantId = await AsyncStorage.getItem('merchant_id');
      if (profile) {
        setBusinessName(profile.business_name);
        setLogoUrl(profile.logo_url && profile.logo_url !== 'default-merchant-logo' ? profile.logo_url : null);
        resolvedMerchantId = profile.id || resolvedMerchantId;
        setVerificationStatus((profile.verification_status as 'pending' | 'approved' | 'rejected') || 'pending');
        setRejectionReason(profile.rejection_reason || null);
      }
      setMerchantId(resolvedMerchantId);

      // Load analytics
      if (resolvedMerchantId) {
        const analytics = await getMerchantAnalytics(resolvedMerchantId);
        setTotalRevenue(analytics.totalRevenue);
        setTotalTransactions(analytics.totalTransactions);
        setSuccessCount(analytics.successTransactions || 0);
        setPendingCount(analytics.pendingTransactions);

        const transactions = await getMerchantTransactions(resolvedMerchantId, 10);
        setRecentTransactions(transactions);
      }
    } catch (error) {
      console.error('Failed to load dashboard:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadDashboard();
  };

  // Recovery path for failed on-chain contract sync.
  const handleRetrySync = async () => {
    if (!merchantId || !walletAddress || syncing) return;
    setSyncing(true);
    const result = await syncMerchantContract(merchantId, walletAddress);
    setSyncing(false);
    if (result.success) {
      setContractSynced(true);
      merchantEvents.emit('merchantRegistered');
      AlertManager.alert('Synced', 'Your merchant account is now ready to accept QR payments.', undefined, { type: 'success' });
    } else {
      AlertManager.alert(
        'Sync Failed',
        result.error || 'Could not complete contract sync. Please try again in a moment.',
        undefined,
        { type: 'error' }
      );
    }
  };

  const goToShowQR = () => navigation.navigate('MerchantGlobalQR');
  const goToCreateQR = () => navigation.navigate('MerchantQRGenerator');

  return (
    <Screen
      loading={loading}
      header={<Header title="Merchant Dashboard" onBack={() => navigation.goBack()} />}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
    >
      {/* Welcome */}
      <View style={styles.welcome}>
        <Image
          source={logoUrl ? { uri: logoUrl } : DEFAULT_MERCHANT_LOGO}
          style={styles.businessLogo}
          onError={() => setLogoUrl(null)}
        />
        <View style={styles.welcomeText}>
          <Text style={styles.greeting}>Welcome back,</Text>
          <Text style={styles.businessName} numberOfLines={2}>{businessName || 'Merchant'}</Text>
        </View>
      </View>

      {/* Revenue hero */}
      <View style={styles.revenueCard}>
        <View style={styles.revenueLabelRow}>
          <Ionicons name="trending-up-outline" size={16} color={COLORS.textInverse} />
          <Text style={styles.revenueLabel}>Total revenue</Text>
        </View>
        <Text style={styles.revenueValue}>{formatMoneyBalance(parseFloat(totalRevenue))}</Text>
        <View style={styles.settlementRow}>
          <Ionicons name="shield-checkmark-outline" size={13} color={COLORS.textInverse} />
          <Text style={styles.settlementText}>Settled on Stellar testnet</Text>
        </View>
      </View>

      {/* Stats */}
      <View style={styles.statsRow}>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>{totalTransactions}</Text>
          <Text style={styles.statLabel}>Payments</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={[styles.statValue, { color: COLORS.success }]}>{successCount}</Text>
          <Text style={styles.statLabel}>Confirmed</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={[styles.statValue, { color: COLORS.warning }]}>{pendingCount}</Text>
          <Text style={styles.statLabel}>Pending</Text>
        </View>
      </View>

      {/* KYB / verification status banner */}
      {verificationStatus === 'pending' && (
        <View style={[styles.kybBanner, styles.kybPending]}>
          <Ionicons name="time-outline" size={18} color={COLORS.warning} />
          <View style={styles.kybBannerText}>
            <Text style={[styles.kybBannerTitle, { color: COLORS.warning }]}>Verification under review</Text>
            <Text style={styles.kybBannerSubtitle}>
              Your merchant account is being reviewed. QR payments will be enabled once approved.
            </Text>
          </View>
        </View>
      )}
      {verificationStatus === 'rejected' && (
        <View style={[styles.kybBanner, styles.kybRejected]}>
          <Ionicons name="close-circle-outline" size={18} color={COLORS.error} />
          <View style={styles.kybBannerText}>
            <Text style={[styles.kybBannerTitle, { color: COLORS.error }]}>Verification rejected</Text>
            <Text style={styles.kybBannerSubtitle}>
              {rejectionReason || 'Your application was not approved. Please contact support.'}
            </Text>
          </View>
        </View>
      )}
      {verificationStatus === 'approved' && (
        <View style={[styles.kybBanner, styles.kybApproved]}>
          <Ionicons name="shield-checkmark-outline" size={18} color={COLORS.success} />
          <View style={styles.kybBannerText}>
            <Text style={[styles.kybBannerTitle, { color: COLORS.success }]}>Account approved</Text>
            <Text style={styles.kybBannerSubtitle}>Your merchant account is active and ready to accept payments.</Text>
          </View>
        </View>
      )}

      {/* Business status */}
      <Section title="Business status">
        <View style={styles.card}>
          <ActionRow
            style={styles.rowFlat}
            icon="checkmark-circle"
            iconColor={COLORS.success}
            iconBackground={COLORS.successBg}
            title="Verified merchant"
            subtitle="Email verified during registration"
          />
          <View style={styles.divider} />
          {contractSynced ? (
            <ActionRow
              style={styles.rowFlat}
              icon="git-network-outline"
              iconColor={COLORS.success}
              iconBackground={COLORS.successBg}
              title="Contract synced"
              subtitle="Connected to the C-Pay payment contract"
            />
          ) : (
            <ActionRow
              style={styles.rowFlat}
              icon="alert-circle"
              iconColor={COLORS.warning}
              iconBackground={COLORS.warningBg}
              title="Contract sync incomplete"
              subtitle="Finish sync so QR payments can settle"
              right={
                <Button
                  title={syncing ? 'Syncing…' : 'Retry'}
                  onPress={handleRetrySync}
                  variant="primary"
                  size="sm"
                  loading={syncing}
                  disabled={syncing}
                />
              }
            />
          )}
          <View style={styles.divider} />
          <ActionRow
            style={styles.rowFlat}
            icon={contractSynced ? 'qr-code' : 'qr-code-outline'}
            iconColor={contractSynced ? COLORS.success : COLORS.textTertiary}
            iconBackground={contractSynced ? COLORS.successBg : COLORS.background}
            title="QR payments"
            subtitle={contractSynced ? 'Ready to accept payments' : 'Not ready until contract sync completes'}
          />
        </View>
      </Section>

      {/* QR actions */}
      <Section title="Get paid">
        <View style={styles.card}>
          <ActionRow
            style={styles.rowFlat}
            icon="qr-code-outline"
            title="Show payment QR"
            subtitle="Display your QR for customers to scan"
            onPress={goToShowQR}
          />
          <View style={styles.divider} />
          <ActionRow
            style={styles.rowFlat}
            icon="add-circle-outline"
            title="Create payment QR"
            subtitle="Request a specific amount"
            onPress={goToCreateQR}
          />
        </View>
      </Section>

      {/* Payments received */}
      <Section
        title="Payments received"
        subtitle={recentTransactions.length > 0 ? 'Recent 10 transactions' : undefined}
        actionLabel={recentTransactions.length > 0 ? 'View All' : undefined}
        onActionPress={() => navigation.navigate('MerchantTransactions')}
      >
        {recentTransactions.length === 0 ? (
          <View style={styles.emptyCard}>
            <View style={styles.emptyIcon}>
              <Ionicons name="receipt-outline" size={32} color={COLORS.primary} />
            </View>
            <Text style={styles.emptyTitle}>No payments yet</Text>
            <Text style={styles.emptySubtitle}>
              Share your payment QR to receive your first payment.
            </Text>
            <Button
              title="Show my QR"
              onPress={goToShowQR}
              variant="primary"
              size="md"
              style={styles.emptyButton}
            />
          </View>
        ) : (
          <View style={styles.transactionsList}>
            {recentTransactions.map((tx) => {
              const status = TX_STATUS[tx.status] || TX_STATUS.pending;
              return (
                <TouchableOpacity
                  key={tx.id}
                  style={styles.transactionCard}
                  activeOpacity={0.7}
                  onPress={() => {
                    setSelectedTransaction({ ...tx, transaction_type: 'merchant' });
                    setShowTransactionModal(true);
                  }}
                >
                  <View style={styles.transactionHeader}>
                    <View style={styles.transactionInfo}>
                      <View style={styles.transactionHashRow}>
                        <Text style={styles.transactionId}>{formatTransactionHash(tx.tx_hash)}</Text>
                        <Ionicons name="open-outline" size={13} color={COLORS.primary} />
                      </View>
                      <Text style={styles.transactionDate}>{formatDateShort(tx.created_at)}</Text>
                    </View>
                    <View style={styles.transactionAmountContainer}>
                      <Text style={styles.transactionAmount}>+{formatMoneyBalance(parseFloat(tx.amount))}</Text>
                      <Text style={styles.transactionAmountSub}>Stellar settlement</Text>
                    </View>
                  </View>
                  <View style={styles.transactionFooter}>
                    <SenderInfo fromAddress={tx.from_address} senderName={tx.sender_name} />
                    <View style={[styles.statusBadge, { backgroundColor: status.bg }]}>
                      <Text style={[styles.statusText, { color: status.color }]}>{status.label}</Text>
                    </View>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </Section>

      <TransactionDetailModal
        visible={showTransactionModal}
        transaction={selectedTransaction}
        onClose={() => {
          setShowTransactionModal(false);
          setSelectedTransaction(null);
        }}
        currentWallet={walletAddress}
        isMerchantView={true}
      />
    </Screen>
  );
};

const styles = StyleSheet.create({
  welcome: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    marginBottom: SPACING.lg,
  },
  businessLogo: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 2,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
  },
  welcomeText: {
    flex: 1,
  },
  greeting: {
    fontSize: FONT_SIZES.md,
    color: COLORS.textSecondary,
  },
  businessName: {
    fontSize: FONT_SIZES.xxl,
    fontWeight: '800',
    color: COLORS.text,
  },
  revenueCard: {
    backgroundColor: COLORS.primary,
    borderRadius: BORDER_RADIUS.xl,
    padding: SPACING.lg,
    marginBottom: SPACING.md,
    ...SHADOWS.md,
  },
  revenueLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  revenueLabel: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textInverse,
    opacity: 0.9,
    fontWeight: '600',
  },
  revenueValue: {
    fontSize: FONT_SIZES.display,
    fontWeight: '800',
    color: COLORS.textInverse,
    marginTop: SPACING.xs,
  },
  settlementRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    marginTop: SPACING.sm,
  },
  settlementText: {
    fontSize: FONT_SIZES.xs,
    color: COLORS.textInverse,
    opacity: 0.85,
  },
  statsRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
    marginBottom: SPACING.xl,
  },
  statCard: {
    flex: 1,
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: SPACING.md,
    alignItems: 'center',
  },
  statValue: {
    fontSize: FONT_SIZES.xxl,
    fontWeight: '800',
    color: COLORS.text,
  },
  statLabel: {
    fontSize: FONT_SIZES.xs,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: SPACING.sm,
  },
  rowFlat: {
    backgroundColor: 'transparent',
    borderRadius: 0,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.border,
    marginHorizontal: SPACING.sm,
  },
  emptyCard: {
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.xl,
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: COLORS.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SPACING.md,
  },
  emptyTitle: {
    fontSize: FONT_SIZES.lg,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: SPACING.xs,
  },
  emptySubtitle: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: SPACING.md,
  },
  emptyButton: {
    marginTop: SPACING.lg,
  },
  transactionsList: {
    gap: SPACING.sm,
  },
  transactionCard: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  transactionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: SPACING.sm,
  },
  transactionInfo: {
    flex: 1,
  },
  transactionHashRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 4,
  },
  transactionId: {
    fontSize: FONT_SIZES.sm,
    fontWeight: '700',
    color: COLORS.primary,
  },
  transactionDate: {
    fontSize: FONT_SIZES.xs,
    color: COLORS.textSecondary,
  },
  transactionAmountContainer: {
    alignItems: 'flex-end',
  },
  transactionAmount: {
    fontSize: FONT_SIZES.md,
    fontWeight: '700',
    color: COLORS.success,
  },
  transactionAmountSub: {
    fontSize: FONT_SIZES.xs,
    color: COLORS.textSecondary,
  },
  transactionFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  transactionFrom: {
    fontSize: FONT_SIZES.xs,
    color: COLORS.textSecondary,
    flex: 1,
  },
  statusBadge: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: 4,
    borderRadius: BORDER_RADIUS.sm,
  },
  statusText: {
    fontSize: FONT_SIZES.xs,
    fontWeight: '700',
  },
  kybBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.sm,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md,
    marginBottom: SPACING.md,
    borderWidth: 1,
  },
  kybPending: {
    backgroundColor: COLORS.warningBg,
    borderColor: COLORS.warning + '40',
  },
  kybRejected: {
    backgroundColor: COLORS.errorBg,
    borderColor: COLORS.error + '40',
  },
  kybApproved: {
    backgroundColor: COLORS.successBg,
    borderColor: COLORS.success + '40',
  },
  kybBannerText: {
    flex: 1,
  },
  kybBannerTitle: {
    fontSize: FONT_SIZES.sm,
    fontWeight: '700',
    marginBottom: 2,
  },
  kybBannerSubtitle: {
    fontSize: FONT_SIZES.xs,
    color: COLORS.textSecondary,
    lineHeight: 16,
  },
});
