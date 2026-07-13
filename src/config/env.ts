import dotenv from 'dotenv';
dotenv.config();

function required(name: string, fallbackForDev: string): string {
  const value = process.env[name];
  if (value && value.length > 0) return value;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return fallbackForDev;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 8080),

  jwtSecret: required('JWT_SECRET', 'dev-only-jwt-secret-change-me'),
  secretEncryptionKey: required('SECRET_ENCRYPTION_KEY', 'dev-only-32-char-encryption-key!'),
  hmacClockSkewSeconds: Number(process.env.HMAC_CLOCK_SKEW_SECONDS ?? 300),

  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? '',
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? '',
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? '',

  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',

  dailyApiKey: process.env.DAILY_API_KEY ?? '',
  dailySubdomain: process.env.DAILY_SUBDOMAIN ?? '',

  expoAccessToken: process.env.EXPO_ACCESS_TOKEN ?? '',

  // Object storage (Backblaze B2, S3-compatible) — KYC documents/selfies.
  b2Endpoint: process.env.B2_ENDPOINT ?? '',
  b2Region: process.env.B2_REGION ?? 'us-east-005',
  b2Bucket: process.env.B2_BUCKET ?? '',
  b2KeyId: process.env.B2_KEY_ID ?? '',
  b2ApplicationKey: process.env.B2_APPLICATION_KEY ?? '',

  // Transactional email — Namecheap Private Email SMTP
  smtpHost: process.env.SMTP_HOST ?? '',
  smtpPort: Number(process.env.SMTP_PORT ?? 587),
  smtpUser: process.env.SMTP_USER ?? '',
  smtpPassword: process.env.SMTP_PASSWORD ?? '',
  emailFrom: process.env.EMAIL_FROM ?? 'MedVAULT <no-reply@med-vault.com>',

  // Public URL doctors/lab staff use to log in — included in welcome emails
  webAppUrl: process.env.WEB_APP_URL ?? 'https://cloud.med-vault.com'
};
