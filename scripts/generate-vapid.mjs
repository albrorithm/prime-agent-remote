import webPush from "web-push";

/**
 * Prints one fresh VAPID keypair for an operator to paste into their
 * environment. Deliberately not wired into the build or startup: a generated
 * key that lands in the repo, or rotates on restart, revokes every push
 * subscription the browsers on the other side already hold.
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
