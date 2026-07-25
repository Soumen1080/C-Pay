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
import { cachePinForSession, clearSessionPin, verifyPin } from './src/services/wallet';

export default function App() {
  const [pinDialogVisible, setPinDialogVisible] = useState(false);
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
        setPinDialogConfig({ title, message, resolve });
        setPinDialogVisible(true);
      });
    });
  }, []);

  const handlePINConfirm = async (pin: string) => {
    setPinDialogVisible(false);

    const isValid = await verifyPin(pin);

    if (isValid) {
      cachePinForSession(pin);
      pinDialogConfig.resolve?.(pin);
    } else {
      AlertManager.alert('Incorrect PIN', 'The PIN you entered is incorrect', undefined, { type: 'error' });
      pinDialogConfig.resolve?.(null);
    }
  };

  const handlePINCancel = () => {
    setPinDialogVisible(false);
    pinDialogConfig.resolve?.(null);
  };

  return (
    <GestureHandlerRootView style={styles.container}>
      <SafeAreaProvider>
        <CustomAlertProvider>
          <Navigation />
          <StatusBar style="auto" />
          <PINDialog
            visible={pinDialogVisible}
            title={pinDialogConfig.title}
            message={pinDialogConfig.message}
            onConfirm={handlePINConfirm}
            onCancel={handlePINCancel}
          />
        </CustomAlertProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
