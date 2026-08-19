import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2024-12-18.acacia" as Stripe.LatestApiVersion,
});

const SITE_URL = process.env.SITE_URL || "https://theroyalpaynes.vibepreview.com";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { amount, customerName, customerEmail, orderDetails, source } = req.body;
    const totalCents = Math.round(parseFloat(amount) * 100);
    if (!totalCents || totalCents < 50) return res.status(400).json({ error: "Invalid order amount" });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: customerEmail || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: totalCents,
          product_data: {
            name: source === "live-form" ? "Live Engraving Order" : "The Royal Payne Order",
            description: orderDetails ? orderDetails.slice(0, 200) : "Personalized keepsakes & engraving",
          },
        },
      }],
      metadata: {
        customer_name: customerName || "",
        source: source || "shop",
        order_details: orderDetails || "",
      },
      success_url: `${SITE_URL}/?payment=success`,
      cancel_url: `${SITE_URL}/?payment=cancelled`,
    });

    return res.status(200).json({ url: session.url });
  } catch (error: any) {
    console.error("Stripe checkout error:", error);
    return res.status(500).json({ error: "Failed to create checkout session", details: error.message });
  }
}
