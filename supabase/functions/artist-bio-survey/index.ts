// Supabase Edge Function: artist-bio-survey
// Purpose: Receive survey submissions, validate payload, persist to
//          public.artist_bio_surveys, and rate-limit by IP hash.
// Method:  POST
// Auth:    public (verify_jwt=false). RLS on the table blocks public reads;
//          service_role inserts via this function with payload validation.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { crypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const IP_SALT = Deno.env.get("BIO_SURVEY_IP_SALT") ?? "loudmusic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
};

const REQUIRED_FIELDS = [
  "artist_name", "artist_email",
  "q1_birthplace_birthdate", "q2_love_for_music", "q3_grow_up_listening",
  "q4_influencers", "q5_first_instrument_song",
  "q6_formal_training", "q7_mentors", "q8_early_lesson",
  "q9_education_influence", "q10_school_activities",
  "q11_pursue_music", "q12_first_break", "q13_challenges",
  "q14_proudest_work", "q15_awards_recognition",
  "q16_style_genre", "q17_inspirations", "q18_creative_process",
  "q19_themes_messages", "q20_evolution",
  "q21_balance", "q22_causes", "q23_fan_moment",
  "q24_inspiration", "q25_legacy",
];

const OPTIONAL_FIELDS = ["artist_phone", "artist_social"];

const MAX_FIELD_LEN = 4000;
const MAX_PAYLOAD_KB = 200;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function bad(msg, status = 400) {
  return json({ ok: false, error: msg }, status);
}

function ipFrom(req) {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "0.0.0.0"
  );
}

async function hashIp(ip) {
  const data = new TextEncoder().encode(ip + IP_SALT);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

// In-memory token bucket. Edge functions are stateless across cold starts,
// so this is best-effort spam mitigation. The durable layer is the table.
const BUCKET = new Map();
function rateLimit(ipHash, limit = 3, windowMs = 60_000) {
  const now = Date.now();
  const entry = BUCKET.get(ipHash);
  if (!entry || entry.reset < now) {
    BUCKET.set(ipHash, { count: 1, reset: now + windowMs });
    return { ok: true, remaining: limit - 1 };
  }
  if (entry.count >= limit) {
    return { ok: false, remaining: 0, resetMs: entry.reset - now };
  }
  entry.count += 1;
  return { ok: true, remaining: limit - entry.count };
}

function isEmail(s) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
}

function isString(v) {
  return typeof v === "string";
}

function sanitize(s) {
  return s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return bad("method_not_allowed", 405);

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_PAYLOAD_KB * 1024) return bad("payload_too_large", 413);

  let body;
  try {
    body = await req.json();
  } catch {
    return bad("invalid_json");
  }
  if (!body || typeof body !== "object") return bad("invalid_body");

  const data = body;
  const ip = ipFrom(req);
  const ipHash = await hashIp(ip);
  const rl = rateLimit(ipHash);
  if (!rl.ok) {
    return json({ ok: false, error: "rate_limited", retry_after_ms: rl.resetMs }, 429);
  }

  const missing = [];
  for (const k of REQUIRED_FIELDS) {
    if (!isString(data[k]) || sanitize(data[k]).length === 0) missing.push(k);
  }
  if (missing.length > 0) {
    return bad(
      "missing_fields: " + missing.slice(0, 5).join(", ") +
      (missing.length > 5 ? ` (+${missing.length - 5} more)` : "")
    );
  }

  if (!isEmail(sanitize(data.artist_email))) return bad("invalid_email");

  const row = { ip_hash: ipHash };
  for (const k of [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]) {
    const v = data[k];
    if (isString(v)) {
      const s = sanitize(v);
      row[k] = s.length > MAX_FIELD_LEN ? s.slice(0, MAX_FIELD_LEN) : s;
    }
  }
  row.user_agent = req.headers.get("user-agent")?.slice(0, 500) ?? null;

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  const { data: inserted, error: insertErr } = await supabase
    .from("artist_bio_surveys")
    .insert(row)
    .select("id")
    .single();

  if (insertErr || !inserted) {
    console.error("insert_failed", insertErr);
    return bad("insert_failed: " + (insertErr?.message ?? "unknown"), 500);
  }

  return json({ ok: true, id: inserted.id });
});
