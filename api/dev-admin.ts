/**
 * Platform Developer Admin API
 *
 * Serverless function (service-role only) that powers the developer admin
 * panel at /dev-admin. It is SEPARATE from maker auth — access is gated by
 * a DEV_ADMIN_KEY env var (a shared secret), not Supabase Auth.
 *
 * Actions:
 *   GET  ?action=list                          → all tenants
 *   POST { action: "activate", tenantId }      → set subscription_status active
 *   POST { action: "deactivate", tenantId }    → set subscription_status inactive
 *   POST { action: "update_plan", tenantId, plan }
 *   GET  ?action=stats                          → platform-wide counts
 *
 * Never returns individual tenant product/order/customer data — only
 * tenant metadata and aggregate counts.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

function cors() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

function getSupabase() {
  const url =
    process.env.SUPABASE_URL || "https://bwuqzywdfbuhgqxjlwfv.supabase.co";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  return createClient(url, serviceKey);
}

function isAuthorized(req: VercelRequest): boolean {
  const key = process.env.DEV_ADMIN_KEY;
  if (!key) return false; // refuse if no secret configured
  const provided =
    (req.headers["x-dev-admin-key"] as string) ||
    (req.query.key as string) ||
    (req.body && req.body.devAdminKey);
  return provided === key;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  Object.entries(cors()).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const supabase = getSupabase();
  const action =
    req.method === "GET"
      ? (req.query.action as string)
      : req.body?.action;

  try {
    // ── List tenants ───────────────────────────────────────────────
    if (req.method === "GET" && (action === "list" || !action)) {
      const { data, error } = await supabase
        .from("rp_tenants")
        .select(
          "id,shop_name,subdomain_slug,subscription_status,plan,stripe_customer_id,stripe_subscription_id,custom_domain,created_at,updated_at",
        )
        .order("created_at", { ascending: false });
      if (error) throw error;
      return res.status(200).json({ tenants: data || [] });
    }

    // ── Platform stats ─────────────────────────────────────────────
    if (req.method === "GET" && action === "stats") {
      const { count: tenantCount } = await supabase
        .from("rp_tenants")
        .select("*", { count: "exact", head: true });
      const { count: activeCount } = await supabase
        .from("rp_tenants")
        .select("*", { count: "exact", head: true })
        .eq("subscription_status", "active");
      const { count: memberCount } = await supabase
        .from("rp_tenant_members")
        .select("*", { count: "exact", head: true });
      return res.status(200).json({
        tenants: tenantCount ?? 0,
        active: activeCount ?? 0,
        members: memberCount ?? 0,
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { tenantId } = req.body;

    // ── Activate / deactivate ──────────────────────────────────────
    if (action === "activate" || action === "deactivate") {
      const status = action === "activate" ? "active" : "inactive";
      const { error } = await supabase
        .from("rp_tenants")
        .update({ subscription_status: status })
        .eq("id", tenantId);
      if (error) throw error;
      return res.status(200).json({ ok: true, status });
    }

    // ── Update plan ────────────────────────────────────────────────
    if (action === "update_plan") {
      const { plan } = req.body;
      const { error } = await supabase
        .from("rp_tenants")
        .update({ plan })
        .eq("id", tenantId);
      if (error) throw error;
      return res.status(200).json({ ok: true, plan });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err: any) {
    console.error("[DevAdmin] error:", err?.message);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
