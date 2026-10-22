export async function getSubscriptionPath(icsURL) {
  // Domain separation keeps this token specific to calendar subscriptions.
  const input = new TextEncoder().encode(`outlook-ics-fixer:subscription:v1\n${icsURL}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  const token = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  return `/${token}.ics`;
}
