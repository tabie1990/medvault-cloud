import { prisma } from '../db/prisma.js';

/**
 * Deliberately lightweight — persists a short record of a background
 * failure so an admin can see it without SSH access to the server, not a
 * replacement for real logging/observability. Never throws itself: a
 * failure to log an error should never be the thing that crashes the
 * process trying to report a different error.
 */
export async function logError(source: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${source}]`, error);
  try {
    await prisma.errorLog.create({ data: { source, message: message.slice(0, 2000) } });
  } catch (loggingError) {
    console.error('failed to persist error log entry:', loggingError);
  }
}
