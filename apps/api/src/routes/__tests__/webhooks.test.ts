import { describe, expect, it } from 'vitest';
import { getSubscriptionUpdate } from '../webhooks.js';

describe('getSubscriptionUpdate', () => {
  const expirationAtMs = Date.parse('2026-10-01T00:00:00.000Z');

  it.each(['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION', 'TRANSFER'])(
    'grants Pro access for %s',
    (type) => {
      expect(
        getSubscriptionUpdate({ type, app_user_id: 'user-1', expiration_at_ms: expirationAtMs })
      ).toEqual({
        tier: 'PRO',
        expiresAt: new Date(expirationAtMs),
      });
    }
  );

  it.each(['CANCELLATION', 'BILLING_ISSUE'])(
    'keeps Pro access for %s until RevenueCat reports expiration',
    (type) => {
      expect(
        getSubscriptionUpdate({ type, app_user_id: 'user-1', expiration_at_ms: expirationAtMs })
      ).toEqual({
        tier: 'PRO',
        expiresAt: new Date(expirationAtMs),
      });
    }
  );

  it.each(['EXPIRATION', 'REFUND'])('revokes access for %s', (type) => {
    expect(getSubscriptionUpdate({ type, app_user_id: 'user-1' })).toEqual({
      tier: 'FREE',
      expiresAt: null,
    });
  });

  it('ignores informational events', () => {
    expect(getSubscriptionUpdate({ type: 'SUBSCRIBER_ALIAS', app_user_id: 'user-1' })).toBeNull();
  });
});
