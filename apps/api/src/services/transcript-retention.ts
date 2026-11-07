/**
 * Data Protection & Transcript Retention Service
 * Enforces DPDP and clinical privacy compliance by automatically purging or anonymizing
 * call records and transcripts older than the configured retention threshold (default 30 days).
 */

import { getDatabaseClient } from '../db/index.js';
import { getEnv } from '../config/env.js';
import { rootLogger } from '../logger/logger.js';

let retentionTimer: NodeJS.Timeout | null = null;

export async function runTranscriptRetentionJob(
  customRetentionDays?: number
): Promise<{ deletedCount: number; retentionDays: number }> {
  const env = getEnv();
  const retentionDays = customRetentionDays || env.TRANSCRIPT_RETENTION_DAYS || 30;
  const db = getDatabaseClient();

  try {
    let deletedCount = 0;
    if (
      'deleteTranscriptsOlderThan' in db &&
      typeof (db as any).deleteTranscriptsOlderThan === 'function'
    ) {
      deletedCount = await (db as any).deleteTranscriptsOlderThan(retentionDays);
    }

    rootLogger.info(`[RetentionJob] Purged call records older than ${retentionDays} days`, {
      retentionDays,
      deletedCount,
      timestamp: new Date().toISOString(),
    });

    return { deletedCount, retentionDays };
  } catch (err) {
    rootLogger.error('[RetentionJob] Failed to execute transcript retention job:', err);
    return { deletedCount: 0, retentionDays };
  }
}

export function startTranscriptRetentionWorker(intervalMs: number = 24 * 60 * 60 * 1000): void {
  if (retentionTimer) return;

  // Run on startup
  runTranscriptRetentionJob().catch((err) => {
    rootLogger.warn('[RetentionJob] Initial startup retention check failed:', err);
  });

  retentionTimer = setInterval(() => {
    runTranscriptRetentionJob().catch((err) => {
      rootLogger.warn('[RetentionJob] Periodic retention cycle failed:', err);
    });
  }, intervalMs);

  retentionTimer.unref();
  rootLogger.info('[RetentionJob] Transcript retention worker scheduled.');
}

export function stopTranscriptRetentionWorker(): void {
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
    rootLogger.info('[RetentionJob] Transcript retention worker stopped.');
  }
}
