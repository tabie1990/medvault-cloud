import { env } from '../config/env.js';

/**
 * Campay integration — ported directly from the HMS's own implementation,
 * which is already tested end-to-end with a real phone. Deliberately not
 * redesigned; same request shapes, same field names, same validation.
 */

function assertConfigured(): void {
  if (!env.campayToken) {
    throw new Error('campay_not_configured');
  }
}

/** Wraps fetch with the shared timeout handling — converts the raw,
 * unhelpful AbortError/DOMException a timeout produces into a clean,
 * named error. Found the need for this via a real Campay /transfer/ call
 * that hung long enough to hit Cloudflare's own origin timeout first,
 * producing a bare "error code: 502" with no useful detail at all. */
async function campayFetch(url: string, options: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
  } catch (e: any) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new Error('campay_request_timed_out');
    }
    throw e;
  }
}

/** Campay is expected to always return JSON, but sandbox environments
 * (and real outages) sometimes return an HTML error/maintenance page
 * instead — found via the /transfer/ endpoint during Block 3 testing.
 * `res.json()` on an HTML body throws an opaque "Unexpected token '<'"
 * SyntaxError that gives no hint what actually happened. This makes that
 * failure mode explicit and diagnosable instead. */
async function safeJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const err: any = new Error('campay_returned_non_json_response');
    err.status = res.status;
    err.rawBody = text.slice(0, 500); // enough to see what actually came back, not the whole page
    throw err;
  }
}

/** Normalizes and validates a Cameroon MoMo number to Campay's expected
 * "237XXXXXXXXX" (12-digit, no plus sign) format. */
export function normalizeCameroonPhone(phone: string): string {
  const cleaned = phone.toString().replace(/[^0-9]/g, '');
  if (!cleaned.startsWith('237') || cleaned.length !== 12) {
    throw new Error('invalid_cameroon_phone');
  }
  return cleaned;
}

/** Requests a collection (the patient pays MedVAULT via Campay's USSD prompt). */
export async function collect(
  phone: string,
  amount: number,
  description: string,
  externalReference: string
): Promise<{ reference: string; ussd_code?: string; operator?: string }> {
  assertConfigured();
  const res = await campayFetch(`${env.campayBaseUrl}collect/`, {
    method: 'POST',
    headers: { Authorization: `Token ${env.campayToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: Math.round(amount).toString(),
      currency: 'XAF',
      from: phone,
      description,
      external_reference: externalReference
    })
  });
  const data = await safeJson(res);
  if (!res.ok) {
    const err: any = new Error(data.message || data.detail || 'campay_collect_failed');
    err.status = res.status;
    err.raw = data;
    throw err;
  }
  return data;
}

/** Polls Campay for a transaction's current status. */
export async function checkTransactionStatus(reference: string): Promise<{ status: string; raw: any }> {
  assertConfigured();
  const res = await campayFetch(`${env.campayBaseUrl}transaction/${reference}/`, {
    headers: { Authorization: `Token ${env.campayToken}` }
  });
  const data = await safeJson(res);
  if (!res.ok) {
    const err: any = new Error(data.message || 'campay_status_check_failed');
    err.status = res.status;
    throw err;
  }
  return { status: data.status, raw: data };
}

/** Disburses funds out to a MoMo number (platform fee or provider payout). */
export async function transfer(
  toPhone: string,
  amount: number,
  description: string,
  externalReference: string
): Promise<{ ok: boolean; data: any }> {
  assertConfigured();
  const res = await campayFetch(`${env.campayBaseUrl}transfer/`, {
    method: 'POST',
    headers: { Authorization: `Token ${env.campayToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: toPhone,
      amount: Math.round(amount).toString(),
      currency: 'XAF',
      description,
      external_reference: externalReference
    })
  });
  return { ok: res.ok, data: await safeJson(res) };
}
