/**
 * Stripe Customer Portal — lets a maker manage/cancel their own subscription
 * through Stripe's hosted portal.
 *
 * POST { tenantId } → returns a Stripe portal session URL.
 * Requires the maker's stripe_customer_id (stored on rp_tenants).
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

function cors() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  Object.entries(cors()).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey)
    return res.status(500).json({ error: "Stripe not configured" });

  const { tenantId } = req.body || {};
  if (!tenantId)
    return res.status(400).json({ error: "tenantId required" });

  try {
    const supabaseUrl =
      process.env.SUPABASE_URL || "https://bwuqzywdfbuhgqxjlwfv.supabase.co";
    const supabase = createClient(
      supabaseUrl,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    const { data: tenant } = await supabase
      .from("rp_tenants")
      .select("stripe_customer_id")
      .eq("id", tenantId)
      .maybeSingle();

    if (!tenant?.stripe_customer_id) {
      return res
        .status(400)
        .json({ error: "No billing account found for this shop." });
    }

    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(secretKey, {
      apiVersion: "2024-06-20" as any,
    });

    const siteUrl = process.env.SITE_URL || "https://app.theroyalpayne.com";
    const portal = await stripe.billingPortal.sessions.create({
      customer: tenant.stripe_customer_id,
      return_url: `${siteUrl}/maker-login`,
    });

    return res.status(200).json({ url: portal.url });
  } catch (err: any) {
    console.error("[Portal] error:", err?.message);
    return res.status(500).json({ error: err?.message });
  }
}
