/**
 * Sets the CORS rule on the B2 bucket used for KYC document uploads
 * (storage.service.ts's getUploadUrl hands the browser a presigned PUT
 * URL straight to B2 — the file never passes through our own server).
 * B2 buckets have no CORS rule by default, so that PUT is blocked by the
 * browser with "No 'Access-Control-Allow-Origin' header is present" even
 * though the exact same presigned URL succeeds from curl/server-side code
 * (CORS is a browser-enforced check, not a server-side restriction) —
 * that mismatch is what made this look like a signing/auth bug at first.
 *
 * Safe to re-run — it replaces the bucket's CORS configuration outright
 * rather than appending, so this is always the full, current allow-list.
 *
 * Usage: npx tsx src/scripts/configure-b2-cors.ts
 */
import { S3Client, PutBucketCorsCommand } from '@aws-sdk/client-s3';
import { env } from '../config/env.js';

const ALLOWED_ORIGINS = [
  'https://med-vault.com',
  'https://staging.med-vault.com',
  'https://cloud.med-vault.com',
  'http://localhost:5173',
  'http://localhost:5174'
];

async function main() {
  if (!env.b2Endpoint || !env.b2Bucket || !env.b2KeyId || !env.b2ApplicationKey) {
    console.error('B2_* environment variables are not fully configured.');
    process.exit(1);
  }

  const client = new S3Client({
    endpoint: env.b2Endpoint,
    region: env.b2Region,
    credentials: { accessKeyId: env.b2KeyId, secretAccessKey: env.b2ApplicationKey },
    forcePathStyle: true
  });

  await client.send(
    new PutBucketCorsCommand({
      Bucket: env.b2Bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: ALLOWED_ORIGINS,
            AllowedMethods: ['PUT', 'GET', 'HEAD'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 3600
          }
        ]
      }
    })
  );

  console.log(`CORS configured on bucket "${env.b2Bucket}" for:`);
  ALLOWED_ORIGINS.forEach((o) => console.log(`  - ${o}`));
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to configure B2 bucket CORS:', err);
  process.exit(1);
});
