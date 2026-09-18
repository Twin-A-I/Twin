/**
 * Webhook routes
 *
 * POST /webhooks/revenuecat — receives subscription lifecycle events from RevenueCat
 * and updates the user's subscription tier in the database.
 *
 * Security: RevenueCat signs webhook payloads with a shared secret sent in the
 * Authorization header. Set REVENUECAT_WEBHOOK_SECRET in your environment.
 */

import type { FastifyPluginAsync } from 'fastify';
import { db } from '../lib/db.js';
import { setUserSubscription } from '../lib/subscription.js';

// RevenueCat event types that affect the subscription tier
const ACTIVE_PRO_EVENTS = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'PRODUCT_CHANGE',
  'UNCANCELLATION',
  'TRANSFER',
  // These events do not remove an active entitlement. RevenueCat will emit an
  // EXPIRATION event when access actually ends.
  'CANCELLATION',
  'BILLING_ISSUE',
]);

const FREE_EVENTS = new Set(['EXPIRATION', 'REFUND']);

interface RevenueCatWebhookBody {
  event: {
    type: string;
    app_user_id: string;
    expiration_at_ms?: number;
    original_app_user_id?: string;
  };
}

export function getSubscriptionUpdate(event: RevenueCatWebhookBody['event']): {
  tier: 'FREE' | 'PRO';
  expiresAt: Date | null;
} | null {
  const expiresAt = event.expiration_at_ms ? new Date(event.expiration_at_ms) : null;

  if (ACTIVE_PRO_EVENTS.has(event.type)) {
    return { tier: 'PRO', expiresAt };
  }

  if (FREE_EVENTS.has(event.type)) {
    return { tier: 'FREE', expiresAt: null };
  }

  return null;
}

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /webhooks/revenuecat
   * No Firebase auth — verified via shared secret in Authorization header.
   */
  app.post<{ Body: RevenueCatWebhookBody }>('/webhooks/revenuecat', async (request, reply) => {
    // Verify shared secret
    const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
    if (!secret) {
      request.log.error('RevenueCat webhook received without server secret configured');
      return reply.status(503).send({ error: 'Webhook authentication is not configured' });
    }

    const authHeader = request.headers['authorization'];
    if (authHeader !== secret) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const body = request.body as RevenueCatWebhookBody;
    if (!body?.event?.type || !body?.event?.app_user_id) {
      return reply.status(400).send({ error: 'Invalid payload' });
    }

    const { app_user_id } = body.event;
    const userId = app_user_id;

    // Verify user exists
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) {
      // User may not exist yet (edge case) — acknowledge and ignore
      return reply.status(200).send({ ok: true });
    }

    const update = getSubscriptionUpdate(body.event);
    if (update) {
      await setUserSubscription(userId, update.tier, update.expiresAt);
      request.log.info(
        { userId, type: body.event.type, tier: update.tier, expiresAt: update.expiresAt },
        'RevenueCat subscription state updated'
      );
    }
    // Other event types (e.g. TEST, SUBSCRIBER_ALIAS) — acknowledge, no action

    return reply.status(200).send({ ok: true });
  });
};
