// Wishkeeper — fetch-product Edge Function
//
// Deploy with:
//   supabase functions deploy fetch-product
//
// Called from the frontend as:
//   supabaseClient.functions.invoke('fetch-product', { body: { url } })
//
// Runs server-side, so it isn't subject to browser CORS rules and
// isn't sharing a rate limit with every other user of a public proxy.
// It still can't get past sites that require JavaScript to render
// content, or that actively block non-browser traffic — in that case
// it returns whatever it *could* find (often nothing), and the
// frontend falls back to manual entry.

import { serve } from "https://deno.land/std@0.203.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function decodeEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function getMeta(html: string, props: string[]): string | null {
  for (const prop of props) {
    let re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`,
      "i",
    );
    let m = html.match(re);
    if (m) return decodeEntities(m[1]);

    re = new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`,
      "i",
    );
    m = html.match(re);
    if (m) return decodeEntities(m[1]);
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { url } = await req.json();
    if (!url || typeof url !== "string") {
      throw new Error("Missing 'url' in request body");
    }

    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(9000),
    });

    if (!res.ok) {
      throw new Error(`Target site responded with ${res.status}`);
    }

    const html = await res.text();

    const title =
      getMeta(html, ["og:title", "twitter:title"]) ||
      decodeEntities(html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? "") ||
      null;

    const image =
      getMeta(html, ["og:image", "og:image:secure_url", "twitter:image"]) || null;

    let priceRaw = getMeta(html, ["product:price:amount", "og:price:amount"]);
    if (!priceRaw) {
      const m = html.match(/[$£€]\s?(\d{1,5}(?:,\d{3})*(?:\.\d{2})?)/);
      if (m) priceRaw = m[1];
    }
    const price = priceRaw ? parseFloat(priceRaw.replace(/[^0-9.]/g, "")) : null;

    return new Response(
      JSON.stringify({
        title,
        image,
        price: price != null && !isNaN(price) ? price : null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
