import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import { env } from '../config/env.js';

/**
 * Backblaze B2, accessed via its S3-compatible API. Used for KYC documents
 * (national ID, medical license, selfies, business registration) — never
 * publicly readable. The client uploads directly to B2 using a short-lived
 * presigned PUT URL (so KYC files never pass through our own server), and
 * anyone authorized to view one later (the admin KYC review screen) gets a
 * short-lived presigned GET URL instead of a permanent public link.
 */

function client(): S3Client {
  return new S3Client({
    endpoint: env.b2Endpoint,
    region: env.b2Region,
    credentials: { accessKeyId: env.b2KeyId, secretAccessKey: env.b2ApplicationKey },
    forcePathStyle: true
  });
}

function isConfigured(): boolean {
  return Boolean(env.b2Endpoint && env.b2Bucket && env.b2KeyId && env.b2ApplicationKey);
}

/**
 * Returns a presigned URL the client can PUT the file to directly, plus the
 * storage key to record in the database (never the raw URL — URLs expire,
 * keys don't).
 */
export async function getUploadUrl(
  keyPrefix: string,
  fileName: string,
  contentType: string
): Promise<{ uploadUrl: string; key: string }> {
  if (!isConfigured()) {
    throw new Error('Object storage is not configured (B2_* environment variables missing)');
  }
  const key = `${keyPrefix}/${crypto.randomUUID()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const command = new PutObjectCommand({ Bucket: env.b2Bucket, Key: key, ContentType: contentType });
  const uploadUrl = await getSignedUrl(client(), command, { expiresIn: 600 }); // 10 minutes
  return { uploadUrl, key };
}

/** Short-lived read access for admin review — never a permanent public link. */
export async function getDownloadUrl(key: string): Promise<string> {
  if (!isConfigured()) {
    throw new Error('Object storage is not configured (B2_* environment variables missing)');
  }
  const command = new GetObjectCommand({ Bucket: env.b2Bucket, Key: key });
  return getSignedUrl(client(), command, { expiresIn: 600 });
}

/**
 * Direct server-side upload from a buffer — distinct from getUploadUrl,
 * which hands a presigned PUT URL to a browser client. This is for cases
 * where the server itself already has the file's bytes in hand (e.g.
 * downloaded from WhatsApp's Media API) and just needs to store them,
 * with no client round-trip involved.
 */
export async function uploadBuffer(keyPrefix: string, fileName: string, contentType: string, buffer: Buffer): Promise<{ key: string }> {
  if (!isConfigured()) {
    throw new Error('Object storage is not configured (B2_* environment variables missing)');
  }
  const key = `${keyPrefix}/${crypto.randomUUID()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  await client().send(new PutObjectCommand({ Bucket: env.b2Bucket, Key: key, ContentType: contentType, Body: buffer }));
  return { key };
}

export function storageConfigured(): boolean {
  return isConfigured();
}

/**
 * A real B2 existence check, not an assumption — added after a real case
 * where a confirmed upload (client got a 200 from the presigned PUT, our
 * own confirm endpoint got a 200 too) still resulted in the object not
 * actually being readable later, silently, only surfacing as a failure
 * when a PDF tried to embed it. Whatever caused that specific gap isn't
 * fully diagnosed yet — this doesn't explain it, it just makes sure it
 * can never again result in a broken key silently saved to the database.
 */
export async function objectExists(key: string): Promise<boolean> {
  if (!isConfigured()) return false;
  try {
    await client().send(new HeadObjectCommand({ Bucket: env.b2Bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetches an object's bytes directly, for the one case where we want to
 * proxy a private B2 object through our own server rather than handing
 * out a presigned URL — doctor profile photos (GET /doctors/:id/photo).
 * A presigned URL works fine for a one-off admin KYC review, but a photo
 * that gets requested on every doctor-list render needs a stable URL the
 * browser can actually cache; that only works if our own server's URL is
 * what's cached, with the (constantly-rotating) B2 URL as an
 * implementation detail behind it. Not used for KYC docs — those should
 * never pass through anything but a short-lived, individually-authorized
 * presigned URL.
 */
export async function getObjectBytes(key: string): Promise<{ body: Buffer; contentType: string } | null> {
  if (!isConfigured()) return null;
  try {
    const res = await client().send(new GetObjectCommand({ Bucket: env.b2Bucket, Key: key }));
    const chunks: Uint8Array[] = [];
    // @ts-expect-error - Body is a Node Readable in this SDK's Node runtime
    for await (const chunk of res.Body) chunks.push(chunk);
    return { body: Buffer.concat(chunks), contentType: res.ContentType ?? 'application/octet-stream' };
  } catch (err) {
    console.error(`getObjectBytes failed for key ${key}:`, err);
    return null;
  }
}
