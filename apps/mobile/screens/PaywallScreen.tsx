/**
 * PaywallScreen
 *
 * Shown when a free user hits a usage limit or taps "Upgrade".
 * Monthly / Annual toggle, feature list, purchase CTA, restore link.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  ScrollView,
} from 'react-native';
import type { PurchasesPackage } from 'react-native-purchases';
import { useSubscription } from '../contexts/SubscriptionContext';

interface PaywallScreenProps {
  onClose: () => void;
  reason?: string; // e.g. "audio_minutes_limit_reached" | "chat_limit_reached"
}

const FEATURES = [
  { icon: '🎙️', text: 'Unlimited recordings' },
  { icon: '⏱️', text: 'Up to 2 hours per recording' },
  { icon: '💬', text: 'Unlimited AI chat' },
  { icon: '🎤', text: 'Re-enroll voice profile anytime' },
  { icon: '📚', text: 'Full recording history' },
];

const REASON_MESSAGES: Record<string, string> = {
  audio_minutes_limit_reached: "You've used all 120 free recording minutes this month.",
  chat_limit_reached: "You've used all 20 free chat messages today.",
  voice_reenroll: 'Re-enrolling your voice requires Twin Pro.',
};

export default function PaywallScreen({ onClose, reason }: PaywallScreenProps) {
  const { offerings, purchase, restore, loading } = useSubscription();
  const [selectedPlan, setSelectedPlan] = useState<'monthly' | 'annual'>('annual');
  const [purchasing, setPurchasing] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const current = offerings?.current;
  const monthlyPkg: PurchasesPackage | undefined = current?.monthly ?? undefined;
  const annualPkg: PurchasesPackage | undefined = current?.annual ?? undefined;
  const selectedPkg = selectedPlan === 'monthly' ? monthlyPkg : annualPkg;

  const monthlyPrice = monthlyPkg?.product.priceString ?? '$4.99';
  const annualPrice = annualPkg?.product.priceString ?? '$29.99';

  const handlePurchase = async () => {
    if (!selectedPkg) {
      Alert.alert('Not available', 'Unable to load subscription options. Please try again.');
      return;
    }
    setPurchasing(true);
    try {
      const success = await purchase(selectedPkg);
      if (success) {
        Alert.alert('Welcome to Twin Pro! 🎉', 'Your subscription is now active.', [
          { text: "Let's go", onPress: onClose },
        ]);
      }
    } finally {
      setPurchasing(false);
    }
  };

  const handleRestore = async () => {
    setRestoring(true);
    try {
      const success = await restore();
      if (success) {
        Alert.alert('Restored!', 'Your Twin Pro subscription has been restored.', [
          { text: 'OK', onPress: onClose },
        ]);
      } else {
        Alert.alert('No purchases found', 'No active Pro subscription found for this Apple ID.');
      }
    } finally {
      setRestoring(false);
    }
  };

  const reasonMessage = reason ? REASON_MESSAGES[reason] : null;

  return (
    <View style={styles.container}>
      {/* Close button */}
      <TouchableOpacity style={styles.closeButton} onPress={onClose}>
        <Text style={styles.closeText}>✕</Text>
      </TouchableOpacity>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <Text style={styles.badge}>TWIN PRO</Text>
        <Text style={styles.title}>Unlock the full experience</Text>

        {reasonMessage && (
          <View style={styles.reasonBanner}>
            <Text style={styles.reasonText}>{reasonMessage}</Text>
          </View>
        )}

        {/* Plan toggle */}
        <View style={styles.toggle}>
          <TouchableOpacity
            style={[styles.toggleOption, selectedPlan === 'monthly' && styles.toggleSelected]}
            onPress={() => setSelectedPlan('monthly')}
          >
            <Text
              style={[styles.toggleLabel, selectedPlan === 'monthly' && styles.toggleLabelSelected]}
            >
              Monthly
            </Text>
            <Text
              style={[styles.togglePrice, selectedPlan === 'monthly' && styles.toggleLabelSelected]}
            >
              {monthlyPrice}/mo
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.toggleOption, selectedPlan === 'annual' && styles.toggleSelected]}
            onPress={() => setSelectedPlan('annual')}
          >
            <View style={styles.savingsBadge}>
              <Text style={styles.savingsText}>SAVE 50%</Text>
            </View>
            <Text
              style={[styles.toggleLabel, selectedPlan === 'annual' && styles.toggleLabelSelected]}
            >
              Annual
            </Text>
            <Text
              style={[styles.togglePrice, selectedPlan === 'annual' && styles.toggleLabelSelected]}
            >
              {annualPrice}/yr
            </Text>
          </TouchableOpacity>
        </View>

        {/* Features */}
        <View style={styles.featureList}>
          {FEATURES.map((f, i) => (
            <View key={i} style={styles.featureRow}>
              <Text style={styles.featureIcon}>{f.icon}</Text>
              <Text style={styles.featureText}>{f.text}</Text>
            </View>
          ))}
        </View>

        {/* CTA */}
        <TouchableOpacity
          style={[styles.cta, (purchasing || loading) && styles.ctaDisabled]}
          onPress={handlePurchase}
          disabled={purchasing || loading || !selectedPkg}
        >
          {purchasing ? (
            <ActivityIndicator color="#000" />
          ) : (
            <Text style={styles.ctaText}>
              {selectedPlan === 'monthly'
                ? `Continue — ${monthlyPrice}/mo`
                : `Get Twin Pro — ${annualPrice}/yr`}
            </Text>
          )}
        </TouchableOpacity>

        {selectedPlan === 'monthly' && (
          <Text style={styles.trialNote}>
            Any available free trial or introductory offer will be shown before you confirm your
            purchase. Cancel anytime.
          </Text>
        )}

        {/* Restore */}
        <TouchableOpacity onPress={handleRestore} disabled={restoring} style={styles.restoreButton}>
          {restoring ? (
            <ActivityIndicator size="small" color="#555" />
          ) : (
            <Text style={styles.restoreText}>Restore purchases</Text>
          )}
        </TouchableOpacity>

        <Text style={styles.legal}>
          Payment charged to your Apple ID. Subscription auto-renews unless cancelled at least 24
          hours before the end of the current period.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  closeButton: {
    position: 'absolute',
    top: 56,
    right: 20,
    zIndex: 10,
    padding: 8,
  },
  closeText: {
    color: '#555',
    fontSize: 18,
  },
  content: {
    paddingTop: 80,
    paddingHorizontal: 24,
    paddingBottom: 48,
    alignItems: 'center',
  },
  badge: {
    color: '#0ff',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 2,
    marginBottom: 12,
  },
  title: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 20,
  },
  reasonBanner: {
    backgroundColor: '#1a1a1a',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginBottom: 24,
    width: '100%',
  },
  reasonText: {
    color: '#aaa',
    fontSize: 14,
    textAlign: 'center',
  },
  toggle: {
    flexDirection: 'row',
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 4,
    marginBottom: 32,
    width: '100%',
  },
  toggleOption: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  toggleSelected: {
    backgroundColor: '#0ff',
  },
  toggleLabel: {
    color: '#888',
    fontSize: 13,
    fontWeight: '600',
  },
  toggleLabelSelected: {
    color: '#000',
  },
  togglePrice: {
    color: '#888',
    fontSize: 15,
    fontWeight: '700',
    marginTop: 2,
  },
  savingsBadge: {
    backgroundColor: '#ff0',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginBottom: 4,
  },
  savingsText: {
    color: '#000',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  featureList: {
    width: '100%',
    marginBottom: 32,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  featureIcon: {
    fontSize: 20,
    marginRight: 14,
    width: 28,
    textAlign: 'center',
  },
  featureText: {
    color: '#ddd',
    fontSize: 16,
  },
  cta: {
    backgroundColor: '#0ff',
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
    width: '100%',
    marginBottom: 12,
  },
  ctaDisabled: {
    opacity: 0.5,
  },
  ctaText: {
    color: '#000',
    fontSize: 17,
    fontWeight: '700',
  },
  trialNote: {
    color: '#666',
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 20,
  },
  restoreButton: {
    paddingVertical: 12,
    marginBottom: 16,
  },
  restoreText: {
    color: '#555',
    fontSize: 14,
    textDecorationLine: 'underline',
  },
  legal: {
    color: '#444',
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 16,
  },
});
