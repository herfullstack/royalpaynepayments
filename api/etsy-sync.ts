/**
 * Etsy Sync Serverless Function
 *
 * Handles:
 *  - POST { action: "pull", shopId }
 *      → fetch all Etsy listings, return them for the import picker
 *  - POST { action: "import", shopId, listing }
 *      → land an Etsy listing as a draft product (returns ok; the actual
 *        product creation happens client-side so it flows through the
 *        existing products store + autosave). This endpoint validates the
 *        listing and extracts unmatched color labels.
 *  - POST { action: "push", shopId, product }
 *      → create a new Etsy DRAFT listing from a platform product
 *
 * Scope: product listings only, one-time manual sync. No inventory or
 * order sync in this phase.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  refreshAccessToken,
  getTokens,
  getConfig,
  isConfigured,
} from "./etsy-oauth";

const ETSY_API_BASE = "https://api.etsy.com/v3";

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "*",
  };
}

async function getAuthHeaders(shopId: string) {
  const cfg = getConfig();
  const token = await refreshAccessToken(shopId);
  return {
    Authorization: `Bearer ${token}`,
    "x-api-key": cfg.clientId,
  };
}

/** Extract color/variant labels from Etsy variant data, for manual matching. */
function extractUnmatchedColors(variants: any[]): string[] {
  const labels = new Set<string>();
  for (const v of variants || []) {
    // Etsy variants have `options` arrays with `value` strings
    if (Array.isArray(v.options)) {
      for (const opt of v.options) {
        if (opt?.value && typeof opt.value === "string") {
          // Only keep things that look like color names (heuristic)
          const val = opt.value.trim();
          if (val.length > 0 && val.length < 40) labels.add(val);
        }
      }
    }
    if (v?.property_name && /color|colour|finish/i.test(v.property_name)) {
      if (v?.value && typeof v.value === "string") labels.add(v.value.trim());
    }
  }
  return Array.from(labels);
}

// ── Pull: fetch all listings from Etsy ─────────────────────────────────

async function pullListings(shopId: string) {
  const headers = await getAuthHeaders(shopId);

  // Get the user's shop id first
  const meRes = await fetch(`${ETSY_API_BASE}/application/users/me`, {
    headers,
  });
  if (!meRes.ok) {
    const err = await meRes.json().catch(() => ({}));
    throw new Error(`Could not fetch Etsy shop: ${err?.error || meRes.status}`);
  }
  const me = await meRes.json();
  const etsyShopId = me?.shop_id;
  if (!etsyShopId) {
    throw new Error("No Etsy shop found on this account");
  }

  // Fetch listings (active + draft)
  const listings: any[] = [];
  for (const state of ["active", "draft"]) {
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const url = `${ETSY_API_BASE}/application/shops/${etsyShopId}/shop-sections/listings?limit=100&offset=${offset}&state=${state}`;
      const res = await fetch(url, { headers });
      if (!res.ok) break;
      const data = await res.json();
      if (Array.isArray(data?.results)) {
        listings.push(...data.results);
      }
      hasMore = data?.results?.length === 100;
      offset += 100;
    }
  }

  // Fetch images + variants for each listing (batched)
  const result = [];
  for (const listing of listings) {
    let images: string[] = [];
    let rawVariants: any[] = [];

    try {
      const imgRes = await fetch(
        `${ETSY_API_BASE}/application/listings/${listing.listing_id}/images`,
        { headers },
      );
      if (imgRes.ok) {
        const imgData = await imgRes.json();
        images = (imgData?.results || [])
          .sort((a: any, b: any) => (a.rank || 0) - (b.rank || 0))
          .map((img: any) => img.url_fullxfull || img.url_570xN || "")
          .filter(Boolean);
      }
    } catch {
      /* non-fatal */
    }

    try {
      const varRes = await fetch(
        `${ETSY_API_BASE}/application/listings/${listing.listing_id}/variations`,
        { headers },
      );
      if (varRes.ok) {
        const varData = await varRes.json();
        rawVariants = varData?.results || [];
      }
    } catch {
      /* non-fatal */
    }

    result.push({
      listingId: String(listing.listing_id),
      title: listing.title || "",
      description: listing.description || "",
      price: parseFloat(listing.price?.amount || "0"),
      currency: listing.price?.currency_code || "USD",
      images,
      rawVariants,
      unmatchedColors: extractUnmatchedColors(rawVariants),
      state: listing.state || "unknown",
    });
  }

  return { ok: true, listings: result };
}

// ── Push: create a draft listing on Etsy ───────────────────────────────

async function pushProduct(shopId: string, product: any) {
  const headers = await getAuthHeaders(shopId);
  const cfg = getConfig();

  // Get shop id
  const meRes = await fetch(`${ETSY_API_BASE}/application/users/me`, {
    headers,
  });
  if (!meRes.ok) {
    throw new Error("Could not fetch Etsy shop");
  }
  const me = await meRes.json();
  const etsyShopId = me?.shop_id;
  if (!etsyShopId) throw new Error("No Etsy shop found");

  // Create the listing as a DRAFT
  const createRes = await fetch(
    `${ETSY_API_BASE}/application/shops/${etsyShopId}/listings`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        quantity: 1,
        title: String(product.name || "Untitled").slice(0, 140),
        description: String(product.description || "").slice(0, 5000),
        price: parseFloat(String(product.price || 0)).toFixed(2),
        who_made: "i_did",
        is_supply: "false",
        when_made: "made_to_order",
        state: "draft", // ALWAYS draft — maker publishes on Etsy's side
        shipping_profile_id: null,
        taxonomy_id: null,
        tags: [],
        materials: [],
        type: "physical",
      }),
    },
  );

  const created = await createRes.json();
  if (!createRes.ok) {
    console.error("[Etsy Sync] Push failed:", created);
    throw new Error(
      created?.error || `Etsy create failed (${createRes.status})`,
    );
  }

  const etsyListingId = String(created.listing_id);

  // Upload primary photo(s) — Etsy requires a multipart upload
  const photos = [product.image, ...(product.gallery || [])].filter(Boolean);
  for (let i = 0; i < Math.min(photos.length, 10); i++) {
    const url = photos[i];
    try {
      // Download the image
      const imgRes = await fetch(url);
      if (!imgRes.ok) continue;
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const contentType =
        imgRes.headers.get("content-type") || "image/jpeg";
      const ext = contentType.includes("png")
        ? "png"
        : contentType.includes("webp")
          ? "webp"
          : "jpg";

      // Upload to Etsy
      const formData = new FormData();
      formData.append("image", new Blob([buf], { type: contentType }), `photo.${ext}`);
      formData.append("rank", String(i));

      await fetch(
        `${ETSY_API_BASE}/application/shops/${etsyShopId}/listings/${etsyListingId}/images`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${headers.Authorization.replace("Bearer ", "")}`,
            "x-api-key": cfg.clientId,
          },
          body: formData,
        },
      );
    } catch (err) {
      console.warn("[Etsy Sync] Photo upload failed:", err);
      // non-fatal — listing is still created as draft
    }
  }

  return { ok: true, etsyListingId };
}

// ── Main handler ───────────────────────────────────────────────────────

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const headers = corsHeaders();
  Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body || {};
  const { action, shopId } = body;

  if (!shopId) {
    return res.status(400).json({ error: "shopId required" });
  }
  if (!isConfigured()) {
    return res.status(400).json({
      ok: false,
      error:
        "Etsy is not configured. Set ETSY_CLIENT_ID, ETSY_CLIENT_SECRET, and ETSY_REDIRECT_URI in Vercel env vars after your Etsy API app is approved.",
    });
  }

  // Verify the shop is connected
  try {
    const tokens = await getTokens(shopId);
    if (!tokens) {
      return res.status(400).json({
        ok: false,
        error: "Etsy shop not connected. Connect your Etsy shop first.",
      });
    }
  } catch (err: any) {
    if (err.message.includes("service key")) {
      return res.status(500).json({
        ok: false,
        error:
          "Supabase service role key not configured. Set SUPABASE_SERVICE_ROLE_KEY in Vercel env vars.",
      });
    }
    return res.status(500).json({ ok: false, error: err.message });
  }

  try {
    if (action === "pull") {
      const result = await pullListings(shopId);
      return res.status(200).json(result);
    }

    if (action === "import") {
      // Validate the listing and return it with unmatched colors flagged.
      // Actual product creation happens client-side via the products store.
      const listing = body.listing;
      if (!listing?.listingId) {
        return res
          .status(400)
          .json({ ok: false, error: "listing required" });
      }
      return res.status(200).json({
        ok: true,
        listing: {
          ...listing,
          unmatchedColors: extractUnmatchedColors(listing.rawVariants || []),
        },
      });
    }

    if (action === "push") {
      const result = await pushProduct(shopId, body.product);
      return res.status(200).json(result);
    }

    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
  } catch (err: any) {
    console.error("[Etsy Sync] Error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
