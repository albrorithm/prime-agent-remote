import webPush from "web-push";

/**
 * Prints one fresh VAPID keypair for an operator to paste into their
 * environment.
 *
 * No longer the only way to get keys: the gateway mints its own on first start
 * and keeps them in its config directory, so notifications work without this.
 * The objection that kept generation out of startup — "a generated key that
 * lands in the repo, or rotates on restart, revokes every push subscription the
 * browsers on the other side already hold" — was about a key that does not
 * persist. `src/server/vapid-keys.ts` persists at mode 0600 and reuses, the same
 * bargain `pairing-token.ts` makes.
 *
 * This is still the right tool for a keypair you want to *choose*: one shared
 * between two installs, or held somewhere the config directory is not.
 *
 * Usage: node scripts/generate-vapid.mjs [subject]
 */
const subject = process.argv[2]?.trim() || "mailto:you@example.com";
const { publicKey, privateKey } = webPush.generateVAPIDKeys();

console.log(`PRIME_WEB_VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`PRIME_WEB_VAPID_PRIVATE_KEY=${privateKey}`);
console.log(`PRIME_WEB_VAPID_SUBJECT=${subject}`);
console.log();
console.log("Keep the private key out of the repo. Rotating it invalidates every");
console.log("existing subscription, so devices must turn notifications on again.");
if (!process.argv[2]) {
  console.log("Pass a real contact as an argument to set the subject:");
  console.log("  node scripts/generate-vapid.mjs mailto:you@example.com");
}
