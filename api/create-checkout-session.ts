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
      hint: "Add it in Vercel → Settings → Environment Variables"
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
      lineItems: clientLineItems,
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

    // NO silent fallback: if test mode is requested but no test key is set,
    // fail loudly so we never charge a live card while believing we're testing.
    let keyToUse: string | undefined;
    if (isTestMode) {
      if (!testKey) {
        return res.status(500).json({
          error: "Test mode requested but STRIPE_SECRET_KEY_TEST is not set",
          details:
            "Stripe Test Mode is ON but no test secret key was found in the serverless function's environment. Add STRIPE_SECRET_KEY_TEST (sk_test_...) in Vercel → Settings → Environment Variables, then redeploy.",
          hint: "Without a test key we refuse to fall back to the LIVE key — that would charge a real card while you believe you're testing.",
        });
      }
      keyToUse = testKey;
    } else {
      if (!liveKey) {
        return res.status(500).json({
          error: "Live mode requested but STRIPE_SECRET_KEY is not set",
          details:
            "No live secret key was found in the serverless function's environment. Add STRIPE_SECRET_KEY (sk_live_...) in Vercel → Settings → Environment Variables, then redeploy.",
        });
      }
      keyToUse = liveKey;
    }

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

    // Build Stripe line_items from the REAL per-product items the customer
    // ordered (sent from the client), so the Stripe dashboard and customer's
    // checkout page accurately show each product — not one generic line.
    // Each client line item has: name, amount (DOLLARS), quantity, description?
    let stripeLineItems = [];
    let usedRealLineItems = false;

    if (Array.isArray(clientLineItems) && clientLineItems.length > 0) {
      // Convert each item to Stripe's price_data format (amount in CENTS).
      const built = clientLineItems.map((item) => {
        const unitCents = Math.round(parseFloat(String(item.amount || 0)) * 100);
        return {
          quantity: parseInt(String(item.quantity || 1), 10) || 1,
          price_data: {
            currency: "usd",
            unit_amount: unitCents,
            product_data: {
              name: String(item.name || "Item").slice(0, 127),
              ...(item.description
                ? { description: String(item.description).slice(0, 500) }
                : {}),
            },
          },
        };
      });

      // Validate that the sum of line items matches the total amount.
      // If it does (within 1 cent for rounding), use real line items.
      const lineTotalCents = built.reduce(
        (sum, li) => sum + li.price_data.unit_amount * li.quantity,
        0,
      );
      if (Math.abs(lineTotalCents - totalCents) <= 1) {
        stripeLineItems = built;
        usedRealLineItems = true;
      } else {
        // Line items don't sum to the total — fall back to a single line so
        // the customer is never undercharged or overcharged. Log it so the
        // discrepancy can be investigated.
        console.warn("[Checkout] Line items sum mismatch — using single line", {
          lineTotalCents,
          totalCents,
          itemCount: built.length,
        });
      }
    }

    if (!usedRealLineItems) {
      // Fallback: single line item with the total (legacy behavior).
      // This ensures we never charge the wrong amount even if line items
      // are missing or don't sum correctly.
      // Generic, reseller-ready fallback name (no hardcoded brand).
      const fallbackName =
        source === "live-form"
          ? "Live Personalization Order"
          : source && source.startsWith("custom-form:")
            ? `${source.slice("custom-form:".length)} Order`
            : "Order";

      stripeLineItems = [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: totalCents,
            product_data: {
              name: fallbackName,
              description: orderDetails
                ? String(orderDetails).slice(0, 500)
                : "Personalized keepsakes & engraving",
            },
          },
        },
      ];
    }

    console.log("[Checkout] Line items:", {
      count: stripeLineItems.length,
      real: usedRealLineItems,
      items: stripeLineItems.map((li) => ({
        name: li.price_data.product_data.name,
        qty: li.quantity,
        unit: li.price_data.unit_amount,
      })),
    });

    // Create session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: customerEmail || undefined,
      line_items: stripeLineItems,
      metadata: {
        customer_name: customerName || "",
        source: source || "shop",
        order_id: orderId || "",
        test_mode: isTestMode ? "true" : "false",
        product_ids: Array.isArray(productIds) ? productIds.join(",") : "",
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
