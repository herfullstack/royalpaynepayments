/**
 * Stripe Webhook Handler
 *
 * Deploy this as a serverless function on Vercel.
 * URL: /api/stripe-webhook
 *
 * Set these env vars in Vercel:
 *   STRIPE_SECRET_KEY        - your live secret key
 *   STRIPE_SECRET_KEY_TEST   - your test secret key
 *   STRIPE_WEBHOOK_SECRET    - from Stripe Dashboard > Developers > Webhooks
 *   SUPABASE_URL             - your Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY - service role key (NOT the anon key)
 *
 * In Stripe Dashboard, create a webhook endpoint pointing to:
 *   https://royalpaynepayments.vercel.app/api/stripe-webhook
 *
 * Subscribe to these events:
 *   - checkout.session.completed
 *   - checkout.session.expired
 *   - charge.refunded
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

// IMPORTANT: Stripe signature verification requires the exact raw request
// body bytes. Vercel's default body parser JSON-parses the body before the
// handler runs, and re-serializing it with JSON.stringify() does NOT
// reproduce the original bytes Stripe signed (key order, spacing, etc. can
// differ), which makes signature verification fail every time. Disabling
// the built-in parser and reading the raw body ourselves fixes this.
export const config = {
  api: {
    bodyParser: false,
  },
};

function getRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function getStripe(testMode?: boolean) {
  const key = testMode
    ? process.env.STRIPE_SECRET_KEY_TEST
    : process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Stripe secret key not configured");
  return new Stripe(key, { apiVersion: "2024-06-20" as Stripe.LatestApiVersion });
}

function getSupabase() {
  const url = process.env.SUPABASE_URL || "https://bwuqzywdfbuhgqxjlwfv.supabase.co";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  return createClient(url, serviceKey);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const stripe = getStripe();
  const supabase = getSupabase();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  const rawBodyBuffer = await getRawBody(req);

  // Verify the webhook signature
  let event: Stripe.Event;
  try {
    const sig = req.headers["stripe-signature"] as string;
    if (webhookSecret && sig) {
      event = stripe.webhooks.constructEvent(rawBodyBuffer, sig, webhookSecret);
    } else {
      // Fallback: parse the raw body if no webhook secret configured (not recommended for production)
      event = JSON.parse(rawBodyBuffer.toString("utf8")) as Stripe.Event;
    }
  } catch (err: any) {
    console.error("[Webhook] Signature verification failed:", err?.message);
    return res.status(400).json({ error: `Webhook signature verification failed: ${err?.message}` });
  }

const stripeForApi = getStripe(!event.livemode);
  
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const orderId = session.metadata?.order_id;
        const testMode = session.metadata?.test_mode === "true";

        // 1. Update order status to "paid"
        {
  const { data: existing } = await supabase
    .from("rp_orders")
    .select("data")
    .eq("id", "singleton")
    .maybeSingle();

  let orders = (existing?.data as any[]) || [];
  const idx = orderId ? orders.findIndex((o: any) => o.id === orderId) : -1;

  if (idx >= 0) {
    orders[idx] = { ...orders[idx], status: "paid", stripeSessionId: session.id, updatedAt: new Date().toISOString() };
  } else {
    const cd = session.customer_details as any;
    orders.push({
      id: orderId || `stripe_${session.id}`,
      status: "paid",
      source: (session.metadata?.source as string) || "online",
      customer: {
        name: session.metadata?.customer_name || cd?.name || "",
        email: session.customer_email || cd?.email || "",
        phone: cd?.phone || "",
      },
      items: [],
      subtotal: (session.amount_total || 0) / 100,
      total: (session.amount_total || 0) / 100,
      notes: "Reconstructed from Stripe payment (no matching pending order found).",
      stripeSessionId: session.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    console.log(`[Webhook] Order ${orderId || session.id} not found locally, inserted reconstructed order from Stripe session`);
  }

  await supabase.from("rp_orders").upsert({
    id: "singleton",
    data: orders,
    updated_at: new Date().toISOString(),
  }, { onConflict: "id" });

  console.log(`[Webhook] Order ${orderId || session.id} marked as paid`);
}

        // 2. Decrement inventory
        const lineItems = await stripeForApi.checkout.sessions.listLineItems(session.id, { limit: 100 });
        const productIds = (session.metadata?.product_ids || "").split(",").filter(Boolean);

        if (productIds.length > 0) {
          const { data: prodData } = await supabase
            .from("rp_products")
            .select("data")
            .eq("id", "singleton")
            .maybeSingle();

          let products = (prodData?.data as any[]) || [];
          products = products.map((p: any) => {
            if (!productIds.includes(p.id)) return p;
            // Count how many of this product were ordered
            const qty = lineItems.data.reduce((sum, li) => {
              // Match by product name in line item description
              if (li.description?.includes(p.name)) {
                return sum + (li.quantity || 1);
              }
              return sum;
            }, 0);
            if (p.stock != null && p.stock > 0) {
              return { ...p, stock: Math.max(0, p.stock - qty) };
            }
            return p;
          });

          await supabase.from("rp_products").upsert({
            id: "singleton",
            data: products,
            updated_at: new Date().toISOString(),
          }, { onConflict: "id" });

          console.log(`[Webhook] Inventory decremented for ${productIds.length} products`);
        }
        break;
      }

      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        const orderId = session.metadata?.order_id;
        if (orderId) {
          const { data: existing } = await supabase
            .from("rp_orders")
            .select("data")
            .eq("id", "singleton")
            .maybeSingle();
          let orders = (existing?.data as any[]) || [];
          orders = orders.map((o: any) =>
            o.id === orderId && o.status === "pending"
              ? { ...o, status: "cancelled", updatedAt: new Date().toISOString() }
              : o
          );
          await supabase.from("rp_orders").upsert({
            id: "singleton",
            data: orders,
            updated_at: new Date().toISOString(),
          }, { onConflict: "id" });
          console.log(`[Webhook] Order ${orderId} marked as cancelled (expired)`);
        }
        break;
      }

      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        const sessionId = charge.metadata?.stripe_session_id;
        if (sessionId) {
          const { data: existing } = await supabase
            .from("rp_orders")
            .select("data")
            .eq("id", "singleton")
            .maybeSingle();
          let orders = (existing?.data as any[]) || [];
          orders = orders.map((o: any) =>
            o.stripeSessionId === sessionId
              ? { ...o, status: "refunded", updatedAt: new Date().toISOString() }
              : o
          );
          await supabase.from("rp_orders").upsert({
            id: "singleton",
            data: orders,
            updated_at: new Date().toISOString(),
          }, { onConflict: "id" });
          console.log(`[Webhook] Order with session ${sessionId} marked as refunded`);
        }
        break;
      }

      default:
        console.log(`[Webhook] Unhandled event type: ${event.type}`);
    }

    return res.status(200).json({ received: true });
  } catch (err: any) {
    console.error("[Webhook] Error processing event:", err?.message);
    return res.status(500).json({ error: "Webhook processing failed", details: err?.message });
  }
}
