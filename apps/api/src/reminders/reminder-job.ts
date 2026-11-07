/**
 * Outbound Reminder Job
 * Driven by the transactional outbox table with FOR UPDATE SKIP LOCKED on Postgres.
 * Processes due 24-hour and 2-hour appointment reminders and triggers the simulated ReminderProvider.
 */

import { getDatabaseClient } from '../db/index.js';
import { globalReminderProvider } from './simulated-reminder-provider.js';
import { rootLogger } from '../logger/logger.js';
import { emitOutboxEvent } from '../db/outbox-relay.js';

let intervalTimer: NodeJS.Timeout | null = null;
let isProcessing = false;

export async function runReminderCycle(dueOnly = true): Promise<number> {
  if (isProcessing) return 0;
  isProcessing = true;

  try {
    const db = getDatabaseClient();
    const pendingReminders = await db.pollPendingReminders(dueOnly);

    if (pendingReminders.length === 0) {
      return 0;
    }

    rootLogger.info(`[ReminderJob] Found ${pendingReminders.length} due reminders for processing`);

    let processedCount = 0;
    for (const reminder of pendingReminders) {
      try {
        const payload = {
          appointmentId: reminder.appointmentId,
          patientName: reminder.patientName,
          patientPhoneMasked: reminder.patientPhoneMasked,
          doctorName: reminder.doctorName,
          appointmentDate: reminder.appointmentDate,
          startTime: reminder.startTime,
          reminderType: reminder.reminderType,
          scheduledFor: reminder.scheduledFor,
        };

        // Dispatch simulated voice call & SMS
        const [callRes, smsRes] = await Promise.all([
          globalReminderProvider.sendReminderCall(payload),
          globalReminderProvider.sendReminderSms(payload),
        ]);

        const scriptCombined = `VOICE: ${callRes.scriptGenerated} | SMS: ${smsRes.scriptGenerated}`;
        await db.markReminderProcessed(reminder.id, scriptCombined);

        await emitOutboxEvent('reminder_dispatched', {
          reminderId: reminder.id,
          appointmentId: reminder.appointmentId,
          patientName: reminder.patientName,
          patientPhoneMasked: reminder.patientPhoneMasked,
          doctorName: reminder.doctorName,
          reminderType: reminder.reminderType,
          timestamp: new Date().toISOString(),
          voiceScript: callRes.scriptGenerated,
          smsScript: smsRes.scriptGenerated,
        });

        processedCount++;
      } catch (itemErr) {
        rootLogger.error(`[ReminderJob] Failed to process reminder ${reminder.id}:`, itemErr);
      }
    }

    return processedCount;
  } catch (err) {
    rootLogger.error('[ReminderJob] Error during reminder cycle:', err);
    return 0;
  } finally {
    isProcessing = false;
  }
}

export function startReminderJob(intervalMs = 3000): void {
  if (intervalTimer) return;
  rootLogger.info(`[ReminderJob] Starting Outbound Reminder Job (interval: ${intervalMs}ms)`);
  intervalTimer = setInterval(() => {
    runReminderCycle().catch((err) => {
      rootLogger.error('[ReminderJob] Unhandled error in periodic reminder job:', err);
    });
  }, intervalMs);
}

export function stopReminderJob(): void {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
    rootLogger.info('[ReminderJob] Stopped Outbound Reminder Job');
  }
}
