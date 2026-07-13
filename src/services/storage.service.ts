import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
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

export function storageConfigured(): boolean {
  return isConfigured();
}
