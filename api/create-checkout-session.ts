/**
 * Stripe Checkout Serverless Function
 * Deploy this to Vercel or Netlify as a serverless function.
 *
 * It receives the order total + customer info from your shop,
 * creates a Stripe Checkout Session with the exact amount,
 * and returns the payment URL for redirect.
 *
 * NEVER put your Stripe secret key in frontend code.
 * Store it as an environment variable: STRIPE_SECRET_KEY
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";

// Initialize Stripe with your secret key from environment variables
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2024-12-18.acacia" as Stripe.LatestApiVersion,
});

// Fallback site URL - the frontend sends the actual return URL
const SITE_URL = process.env.SITE_URL || "https://theroyalpaynes.vibepreview.com";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers (allow your site to call this)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight request first
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      amount,
      customerName,
      customerEmail,
      orderDetails,
      source,
      successUrl,
      cancelUrl,
    } = req.body;

    // Validate amount
    const totalCents = Math.round(parseFloat(amount) * 100);
    if (!totalCents || totalCents < 50) {
      return res.status(400).json({ error: "Invalid order amount" });
    }

    // Create a Stripe Checkout Session
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
              name: source === "live-form"
                ? "Live Engraving Order"
                : "The Royal Payne Order",
              description: orderDetails
                ? orderDetails.slice(0, 200)
                : "Personalized keepsakes & engraving",
            },
          },
        },
      ],
      metadata: {
        customer_name: customerName || "",
        source: source || "shop",
        order_details: orderDetails || "",
      },
      success_url: successUrl || `${SITE_URL}/?payment=success`,
      cancel_url: cancelUrl || `${SITE_URL}/?payment=cancelled`,
    });

    return res.status(200).json({ url: session.url });
  } catch (error: any) {
    console.error("Stripe checkout error:", error);
    return res.status(500).json({
      error: "Failed to create checkout session",
      details: error.message,
    });
  }
}
