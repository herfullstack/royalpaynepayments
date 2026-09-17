/**
 * Maker Signup — creates a Stripe Checkout Session for a platform subscription.
 *
 * Flow:
 *   1. Maker picks a plan on /signup → POSTs here with shopName, email, planId.
 *   2. We create a Stripe Checkout Session (subscription mode) with metadata
 *      carrying the chosen shop name + plan so the webhook can provision the
 *      tenant after payment.
 *   3. Return the Stripe URL; the maker pays; the webhook
 *      (stripe-webhook.ts → checkout.session.completed) provisions the tenant,
 *      creates the auth account, seeds empty catalog data, and emails a login
 *      link.
 *
 * Test mode:
 *   Send `testMode: true` in the request body OR the `x-test-mode: true` header
 *   to use STRIPE_SECRET_KEY_TEST instead of the live key. If test mode is
 *   requested but no test key is set, we fail loudly — we never silently fall
 *   back to the LIVE key (that would charge a real card while you believe
 *   you're testing). This mirrors create-checkout-session.ts.
 *
 * Env vars:
 *   STRIPE_SUBS_SECRET_KEY          — platform billing account (live)
 *   STRIPE_SUBS_SECRET_KEY_TEST     — platform billing account (test; required for test mode)
 *   STRIPE_PRICE_SHOP / STRIPE_PRICE_BUNDLE / STRIPE_PRICE_SHOP_FOUNDING / STRIPE_PRICE_BUNDLE_FOUNDING
 *   STRIPE_PRICE_SHOP_TEST / STRIPE_PRICE_BUNDLE_TEST / ... (optional test-mode price overrides)
 *   SITE_URL (success/cancel redirect origin)
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

function cors(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-test-mode, stripe-signature",
  );
}

const PRICE_ENV: Record<string, string> = {
  shop: "STRIPE_PRICE_SHOP",
  bundle: "STRIPE_PRICE_BUNDLE",
  "shop-founding": "STRIPE_PRICE_SHOP_FOUNDING",
  "bundle-founding": "STRIPE_PRICE_BUNDLE_FOUNDING",
};

// Optional test-mode price overrides. If not set, we reuse the live price ID
// (Stripe test mode can still process a live price ID in test mode as long as
// the price exists on the test account — but ideally you create test prices).
const PRICE_ENV_TEST: Record<string, string> = {
  shop: "STRIPE_PRICE_SHOP_TEST",
  bundle: "STRIPE_PRICE_BUNDLE_TEST",
  "shop-founding": "STRIPE_PRICE_SHOP_FOUNDING_TEST",
  "bundle-founding": "STRIPE_PRICE_BUNDLE_FOUNDING_TEST",
};

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const { shopName, email, planId } = req.body || {};
  if (!shopName || !email || !planId) {
    return res
      .status(400)
      .json({ error: "shopName, email, and planId are required" });
  }

  // ── Determine test vs live ──────────────────────────────────────────
  const isTestMode =
    req.headers["x-test-mode"] === "true" ||
    req.headers["x-test-mode"] === "1" ||
    req.body?.testMode === true ||
    req.body?.testMode === "true";

  const liveKey = process.env.STRIPE_SUBS_SECRET_KEY;
  const testKey = process.env.STRIPE_SUBS_SECRET_KEY_TEST;

  let secretKey: string | undefined;
  if (isTestMode) {
    if (!testKey) {
      return res.status(500).json({
        error:
          "Test mode requested but STRIPE_SUBS_SECRET_KEY_TEST is not set in Vercel env vars.",
        details:
          "Add STRIPE_SUBS_SECRET_KEY_TEST (sk_test_...) in Vercel → Settings → Environment Variables, then redeploy. We refuse to fall back to the LIVE key — that would charge a real card while you believe you're testing.",
      });
    }
    secretKey = testKey;
  } else {
    if (!liveKey) {
      return res
        .status(500)
        .json({ error: "Stripe is not configured (STRIPE_SUBS_SECRET_KEY missing)" });
    }
    secretKey = liveKey;
  }

  // Resolve the price ID. In test mode, prefer a _TEST price override if set;
  // otherwise fall back to the live price env var (works if the price exists
  // on the test account).
  const priceEnvVar = isTestMode
    ? PRICE_ENV_TEST[planId] || PRICE_ENV[planId]
    : PRICE_ENV[planId];
  const priceId = priceEnvVar && process.env[priceEnvVar];
  if (!priceId) {
    return res.status(500).json({
      error: `Plan "${planId}" is not configured. Set ${priceEnvVar} in Vercel env vars.`,
    });
  }

  const siteUrl = process.env.SITE_URL || "https://app.theroyalpayne.com";

  console.log("[Signup] Creating session:", {
    planId,
    mode: isTestMode ? "TEST" : "LIVE",
    keyPrefix: secretKey?.slice(0, 4),
    priceId,
  });

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(secretKey, {
      apiVersion: "2024-06-20" as any,
    });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: {
        platform_signup: "true",
        shop_name: String(shopName).slice(0, 100),
        plan_id: planId,
        signup_email: String(email).slice(0, 200),
        test_mode: isTestMode ? "true" : "false",
      },
      success_url: `${siteUrl}/signup?status=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/signup?status=cancelled`,
    });

    return res.status(200).json({ url: session.url, testMode: isTestMode });
  } catch (err: any) {
    console.error("[Signup] error:", err?.message);
    return res
      .status(500)
      .json({ error: err?.message || "Could not start signup" });
  }
}
