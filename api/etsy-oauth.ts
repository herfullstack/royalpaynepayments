/**
 * Etsy OAuth Serverless Function
 *
 * Handles:
 *  - GET  ?shopId=...           → return connection status (public-safe, no tokens)
 *  - POST { action: "start", shopId, redirectUri } → return Etsy authorize URL
 *  - POST { action: "callback", shopId, code, state } → exchange code for tokens, store in Supabase
 *  - POST { action: "disconnect", shopId } → delete stored tokens
 *
 * Tokens are stored in the `rp_etsy_tokens` Supabase table (server-side only).
 * The browser NEVER receives access/refresh tokens.
 *
 * REQUIRES these Vercel env vars (set after Etsy API app approval):
 *   ETSY_CLIENT_ID
 *   ETSY_CLIENT_SECRET
 *   ETSY_REDIRECT_URI  (e.g. https://app.theroyalpayne.com/api/etsy-oauth)
 *
 * Until those are set, the function returns clear "not configured" errors so
 * the UI can show the right state without crashing.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

const ETSY_API_BASE = "https://api.etsy.com/v3";

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "*",
  };
}

function getConfig() {
  return {
    clientId: process.env.ETSY_CLIENT_ID || "",
    clientSecret: process.env.ETSY_CLIENT_SECRET || "",
    redirectUri: process.env.ETSY_REDIRECT_URI || "",
  };
}

function isConfigured() {
  const c = getConfig();
  return !!(c.clientId && c.clientSecret && c.redirectUri);
}

// ── Supabase token storage (server-side, uses service role if available) ──

function getSupabaseServiceClient() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    "https://bwuqzywdfbuhgqxjlwfv.supabase.co";
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    "";
  if (!serviceKey) return null;
  // Dynamic import to avoid bundling supabase-js when not needed
  return { url, serviceKey };
}

async function supabaseRequest(
  path: string,
  method: string,
  body: any,
  serviceKey: string,
  url: string,
) {
  const res = await fetch(`${url}/rest/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: method === "POST" || method === "PUT" ? "return=representation,resolution=merge-duplicates" : "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    console.error("[Etsy OAuth] Supabase error:", res.status, json);
    throw new Error(`Supabase ${res.status}: ${JSON.stringify(json)?.slice(0, 200)}`);
  }
  return json;
}

async function storeTokens(shopId: string, tokens: any) {
  const sc = getSupabaseServiceClient();
  if (!sc) throw new Error("Supabase service key not configured");
  await supabaseRequest(
    "/rp_etsy_tokens",
    "POST",
    {
      shop_id: shopId,
      etsy_user_id: tokens.user_id || "",
      etsy_shop_name: tokens.shop_name || "",
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: new Date(
        Date.now() + (tokens.expires_in || 3600) * 1000,
      ).toISOString(),
      connected_at: new Date().toISOString(),
    },
    sc.serviceKey,
    sc.url,
  );
}

async function getTokens(shopId: string) {
  const sc = getSupabaseServiceClient();
  if (!sc) throw new Error("Supabase service key not configured");
  const rows = await supabaseRequest(
    `/rp_etsy_tokens?shop_id=eq.${encodeURIComponent(shopId)}&limit=1`,
    "GET",
    null,
    sc.serviceKey,
    sc.url,
  );
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function deleteTokens(shopId: string) {
  const sc = getSupabaseServiceClient();
  if (!sc) throw new Error("Supabase service key not configured");
  await supabaseRequest(
    `/rp_etsy_tokens?shop_id=eq.${encodeURIComponent(shopId)}`,
    "DELETE",
    null,
    sc.serviceKey,
    sc.url,
  );
}

// ── Token refresh ──────────────────────────────────────────────────────

async function refreshAccessToken(shopId: string): Promise<string> {
  const cfg = getConfig();
  const row = await getTokens(shopId);
  if (!row) throw new Error("No Etsy connection found");

  // Refresh if token expires within 5 minutes
  const expiresAt = new Date(row.expires_at).getTime();
  if (Date.now() < expiresAt - 5 * 60 * 1000) {
    return row.access_token;
  }

  const res = await fetch(`${ETSY_API_BASE}/public/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: row.refresh_token,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("[Etsy OAuth] Refresh failed:", data);
    throw new Error("Etsy token refresh failed — reconnect your Etsy shop");
  }
  await storeTokens(shopId, {
    ...data,
    user_id: row.etsy_user_id,
    shop_name: row.etsy_shop_name,
  });
  return data.access_token;
}

// ── Main handler ───────────────────────────────────────────────────────

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const headers = corsHeaders();
  Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") return res.status(200).end();

  // GET = connection status
  if (req.method === "GET") {
    const shopId = (req.query.shopId as string) || "";
    if (!shopId) return res.status(400).json({ error: "shopId required" });
    try {
      const row = await getTokens(shopId);
      if (!row) {
        return res.status(200).json({ connected: false });
      }
      return res.status(200).json({
        connected: true,
        etsyShopName: row.etsy_shop_name,
        etsyUserId: row.etsy_user_id,
        connectedAt: row.connected_at,
      });
    } catch (err: any) {
      // If service key isn't set, report not connected gracefully
      if (err.message.includes("service key")) {
        return res.status(200).json({ connected: false, notConfigured: true });
      }
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body || {};
  const action = body.action;

  if (action === "start") {
    if (!isConfigured()) {
      return res.status(400).json({
        error:
          "Etsy is not configured yet. Set ETSY_CLIENT_ID, ETSY_CLIENT_SECRET, and ETSY_REDIRECT_URI in Vercel env vars after your Etsy API app is approved.",
      });
    }
    const cfg = getConfig();
    const state = `${body.shopId}:${Date.now()}`;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      scope: "listings:read listings:write",
      state,
    });
    return res.status(200).json({
      authorizeUrl: `https://www.etsy.com/oauth/connect?${params.toString()}`,
      state,
    });
  }

  if (action === "callback") {
    if (!isConfigured()) {
      return res.status(400).json({ error: "Etsy not configured" });
    }
    const cfg = getConfig();
    const { shopId, code } = body;
    if (!shopId || !code) {
      return res.status(400).json({ error: "shopId and code required" });
    }
    try {
      // Exchange authorization code for tokens
      const tokenRes = await fetch(`${ETSY_API_BASE}/public/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          redirect_uri: cfg.redirectUri,
          code,
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokenRes.ok) {
        console.error("[Etsy OAuth] Token exchange failed:", tokens);
        return res.status(400).json({
          error: "Etsy authorization failed",
          details: tokens?.error_description || tokens?.error,
        });
      }

      // Fetch the shop name for display
      let shopName = "";
      try {
        const meRes = await fetch(`${ETSY_API_BASE}/application/users/me`, {
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            "x-api-key": cfg.clientId,
          },
        });
        if (meRes.ok) {
          const me = await meRes.json();
          shopName = me?.shop_name || "";
        }
      } catch {
        /* non-fatal */
      }

      await storeTokens(shopId, { ...tokens, shop_name: shopName });
      return res.status(200).json({
        ok: true,
        etsyShopName: shopName,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (action === "disconnect") {
    try {
      await deleteTokens(body.shopId);
      return res.status(200).json({ ok: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
}

// Exported for use by the sync function
export { refreshAccessToken, getTokens, getConfig, isConfigured };
