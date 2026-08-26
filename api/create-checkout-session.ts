/**
 * Stripe Checkout Serverless Function
  *
   * Creates a Stripe Checkout Session and returns the URL for redirect.
    * Uses dynamic import() since project type is "module" (ESM)
     */

import type { VercelRequest, VercelResponse } from "@vercel/node";

const SITE_URL = process.env.SITE_URL || "https://app.theroyalpayne.com";

export default async function handler(req: VercelRequest, res: VercelResponse) {
    // Set JSON headers IMMEDIATELY - before anything else
    // Use wildcard CORS to allow cross-origin requests from any domain
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
    res.setHeader("Access-Control-Allow-Headers", "*"); // Allow ALL headers to prevent CORS issues

    // Handle preflight
    if (req.method === "OPTIONS") {
          return res.status(200).end();
    }

    // GET request = health/test endpoint
    if (req.method === "GET") {
          try {
                  const liveKey = process.env.STRIPE_SECRET_KEY;
                  const testKey = process.env.STRIPE_SECRET_KEY_TEST;

                  const healthData = {
                            status: "ok",
                            stripe: {
                                        installed: true,
                                        hasLiveKey: !!liveKey,
                                        liveKeyLength: liveKey?.length || 0,
                                        liveKeyPrefix: liveKey?.slice(0, 4) || "not_set",
                                        hasTestKey: !!testKey,
                                        testKeyLength: testKey?.length || 0,
                                        testKeyPrefix: testKey?.slice(0, 4) || "not_set",
                            },
                            hint: "If liveKeyPrefix is 'mk_' not 'sk_', your key is masked and won't work"
                  };

                  console.log("[Health Check] Returning:", JSON.stringify(healthData));
                  return res.status(200).json(healthData);
          } catch (err: any) {
                  console.error("[Health Check] Error:", err?.message);
                  return res.status(500).json({
                            status: "error",
                            error: "Health check failed",
                            details: err?.message
                  });
          }
    }

    // Only allow POST for checkout
    if (req.method !== "POST") {
          return res.status(405).json({ error: "Method not allowed" });
    }

    // Check for keys
    const liveKey = process.env.STRIPE_SECRET_KEY;
    const testKey = process.env.STRIPE_SECRET_KEY_TEST;

    if (!liveKey && !testKey) {
          return res.status(500).json({
                  error: "Payment not configured",
                  details: "No STRIPE_SECRET_KEY found in environment",
                  hint: "Add it in Vercel -> Settings -> Environment Variables"
          });
    }

    try {
          // Dynamic import for ESM compatibility (project has "type": "module")
          let stripeModule: any;
          try {
                  const Stripe = await import("stripe");
                  stripeModule = Stripe.default || Stripe;
          } catch (e: any) {
                  console.error("[FATAL] Cannot import stripe:", e.message);
                  return res.status(500).json({
                            error: "Payment module unavailable",
                            details: "Stripe package failed to load",
                            hint: "This shouldn't happen - contact support"
                  });
          }

          const body = req.body || {};
          const {
                  amount,
                  customerName,
                  customerEmail,
                  orderDetails,
                  source,
                  orderId,
                  productIds,
                  successUrl: clientSuccessUrl,
                  cancelUrl: clientCancelUrl,
          } = body;

          // Parse amount
          const totalCents = Math.round(parseFloat(String(amount || 0)) * 100);
          if (!totalCents || totalCents < 50) {
                  return res.status(400).json({ error: "Invalid amount" });
          }

          // Determine which key to use
          const isTestMode =
                  req.headers["x-test-mode"] === "true" ||
                  req.headers["x-test-mode"] === "1" ||
                  body.testMode === true ||
                  body.testMode === "true";

          const keyToUse = (isTestMode && testKey) ? testKey : liveKey;

          // Log key info (NEVER log full key)
          console.log("[Checkout] Creating session:", {
                  amount: totalCents,
                  mode: isTestMode ? "TEST" : "LIVE",
                  keyLength: keyToUse?.length,
                  keyPrefix: keyToUse?.slice(0, 4),
          });

          // Initialize Stripe
          const stripe = new stripeModule(keyToUse, {
                  apiVersion: "2024-06-20",
          });

          // Use client-provided URLs, fall back to SITE_URL
          const finalSuccessUrl = clientSuccessUrl || `${SITE_URL}/?payment=success&order_id=${orderId || ""}`;
          const finalCancelUrl = clientCancelUrl || `${SITE_URL}/?payment=cancelled&order_id=${orderId || ""}`;

          // Create session
          const session = await stripe.checkout.sessions.create({
                  payment_method_types: ["card"],
                  mode: "payment",
                  customer_email: customerEmail || undefined,
                  line_items: [
                    {
                                quantity: 1,
                                price_data: {
                                              currency: "usd",
                                              unit_amount: totalCents,
                                              product_data: {
                                                              name: source === "live-form" ? "Live Engraving Order" : "The Royal Payne Order",
                                                              description: orderDetails
                                                                ? String(orderDetails).slice(0, 500)
                                                                                : "Personalized keepsakes & engraving",
                                              },
                                },
                    },
                          ],
                  metadata: {
                            customer_name: customerName || "",
                            source: source || "shop",
                            order_id: orderId || "",
                            test_mode: isTestMode ? "true" : "false",
                  },
                  success_url: finalSuccessUrl,
                  cancel_url: finalCancelUrl,
          });

          return res.status(200).json({ url: session.url });

    } catch (error: any) {
          console.error("[Checkout Error]:", {
                  message: error?.message,
                  type: error?.type,
                  code: error?.code,
                  stack: error?.stack?.slice(0, 200),
          });

          return res.status(500).json({
                  error: "Payment failed",
                  details: error?.message || "Unknown error",
                  type: error?.type,
                  code: error?.code,
          });
    }
}
