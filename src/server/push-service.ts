import webPush from "web-push";
import type { WebPushConfig } from "./config.js";
import type { AttentionPushPayload } from "./push-payload.js";
import type { PushSubscriptionStore, StoredPushSubscription } from "./push-store.js";

/**
 * An attention request that is still unanswered an hour later is stale enough
 * that waking someone for it is noise. The push service drops it instead.
 */
export const PUSH_TTL_SECONDS = 3_600;

export interface PushSendResult {
  statusCode: number;
}

/** Seam for tests, so the suite never has to reach a real push service. */
export interface PushSender {
  (subscription: StoredPushSubscription, payload: string): Promise<PushSendResult>;
}

function webPushSender(config: WebPushConfig): PushSender {
  return async (subscription, payload) => {
    const result = await webPush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      payload,
      {
        TTL: PUSH_TTL_SECONDS,
        // An agent that cannot continue until someone answers is what push is
        // for; anything quieter defeats the point on a locked phone.
        urgency: "high",
        vapidDetails: {
          subject: config.subject,
          publicKey: config.publicKey,
          privateKey: config.privateKey,
        },
      },
    );
    return { statusCode: result.statusCode };
  };
}

/**
 * Fans one attention request out to every device that asked to be woken.
 *
 * Sends are best-effort by design. A push service being slow or down must
 * never propagate back into the daemon's attention path, so failures are
 * logged and swallowed — except a `404`/`410`, which is the push service
 * saying the endpoint is permanently gone. That is the only automatic way a
 * record leaves the store, and skipping it would leave dead endpoints being
 * retried until the record count evicted them.
 */
export class PushService {
  private readonly send: PushSender;

  constructor(
    private readonly store: PushSubscriptionStore,
    config: WebPushConfig,
    sender?: PushSender,
  ) {
    this.send = sender ?? webPushSender(config);
  }

  async notify(payload: AttentionPushPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const targets = [...this.store.list()];
    await Promise.all(targets.map((subscription) => this.sendOne(subscription, body)));
  }

  private async sendOne(subscription: StoredPushSubscription, body: string): Promise<void> {
    try {
      const { statusCode } = await this.send(subscription, body);
      if (statusCode === 404 || statusCode === 410) await this.forget(subscription);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await this.forget(subscription);
        return;
      }
      // Endpoints are device identifiers, so the log records the failure
      // without them.
      console.error(`Push delivery failed with status ${statusCode ?? "unknown"}`);
    }
  }

  private async forget(subscription: StoredPushSubscription): Promise<void> {
    // The store already applies the removal in memory and retries the write
    // in the background even if this first attempt fails, so a rejection
    // here just means the retry is still in flight — not that the endpoint
    // will keep being sent to.
    await this.store.removeEndpoint(subscription.endpoint).catch(() => {
      console.error("Could not immediately persist removal of an expired push subscription; retrying in the background");
    });
  }
}
