import React, { useState, useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native';
import { Navigation } from './src/navigation';
import { PINDialog, CustomAlertProvider } from './src/components';
import { setPINDialogHandler } from './src/utils/biometric';
import { AlertManager } from './src/utils/alert';
import { cachePinForSession, clearSessionPin, unlockWithPin } from './src/services/wallet';
import { ThemeProvider, useTheme } from './src/constants/theme';

const AppContent = () => {
  const [pinDialogVisible, setPinDialogVisible] = useState(false);
  const [pinFeedback, setPinFeedback] = useState('');
  const [pinLockedUntil, setPinLockedUntil] = useState<number | undefined>();
  const [pinDialogConfig, setPinDialogConfig] = useState({
    title: 'Enter PIN',
    message: 'Enter your 6-digit PIN to confirm',
    resolve: null as ((value: string | null) => void) | null,
  });

  // Track AppState so we can clear the session when the app leaves the foreground.
  const appState = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    // Clear the cached wallet and PIN whenever the app goes to background or
    // becomes inactive.  This ensures a PIN re-entry is required after the app
    // is suspended, consistent with the 15-minute session TTL but enforced
    // immediately on backgrounding rather than waiting for the TTL to expire.
    const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (
        appState.current === 'active' &&
        (nextState === 'background' || nextState === 'inactive')
      ) {
        clearSessionPin();
      }
      appState.current = nextState;
    });

    return () => subscription.remove();
  }, []);

  // Set up PIN dialog handler
  useEffect(() => {
    setPINDialogHandler((title: string, message: string) => {
      return new Promise<string | null>((resolve) => {
        setPinFeedback('');
        setPinLockedUntil(undefined);
        setPinDialogConfig({ title, message, resolve });
        setPinDialogVisible(true);
      });
    });
  }, []);

  const handlePINConfirm = async (pin: string): Promise<boolean> => {
    const result = await unlockWithPin(pin);
    if (result.status === 'OK') {
      setPinDialogVisible(false);
      setPinFeedback('');
      setPinLockedUntil(undefined);
      cachePinForSession(pin);
      pinDialogConfig.resolve?.(pin);
      return true;
    }
    if (result.status === 'STORAGE_ERROR') {
      setPinFeedback("Couldn't access secure storage. Try again.");
    } else if (result.status === 'LOCKED') {
      setPinLockedUntil(result.until);
      setPinFeedback('Too many incorrect attempts.');
    } else if (result.status === 'WIPED') {
      setPinDialogVisible(false);
      pinDialogConfig.resolve?.(null);
      AlertManager.alert('Wallet erased from this device', 'After 15 incorrect PIN attempts, the wallet was removed from this device. Restore it from your encrypted backup if available.', undefined, { type: 'error' });
      return true;
    } else {
      setPinFeedback(`Incorrect PIN. ${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? '' : 's'} remaining before wallet erasure.`);
    }
    return false;
  };

  const handlePINCancel = () => {
    setPinDialogVisible(false);
    pinDialogConfig.resolve?.(null);
  };

  const { colors, isDark } = useTheme();

  return (
    <GestureHandlerRootView style={[styles.container, { backgroundColor: colors.background }]}>
      <SafeAreaProvider>
        <CustomAlertProvider>
          <Navigation />
          <StatusBar style={isDark ? 'light' : 'dark'} />
          <PINDialog
            visible={pinDialogVisible}
            title={pinDialogConfig.title}
            message={pinDialogConfig.message}
            feedback={pinFeedback}
            lockoutUntil={pinLockedUntil}
            onConfirm={handlePINConfirm}
            onCancel={handlePINCancel}
          />
        </CustomAlertProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
};

export default function App() {
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
