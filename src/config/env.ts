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

  expoAccessToken: process.env.EXPO_ACCESS_TOKEN ?? ''
};
