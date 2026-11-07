/**
 * Simulated Outbound Reminder Provider
 * Implements IReminderProvider with Hinglish script generation and structured audit logging.
 * Behind this interface, real telephony or SMS (Twilio, Gupshup, Gnani Voice) can be plugged in without changing domain logic.
 */

import { IReminderProvider, ReminderPayload, ReminderResult } from './types.js';
import { rootLogger } from '../logger/logger.js';

export class SimulatedReminderProvider implements IReminderProvider {
  private sentReminders: ReminderResult[] = [];

  public async sendReminderCall(payload: ReminderPayload): Promise<ReminderResult> {
    const is24h = payload.reminderType === '24h';
    const script = is24h
      ? `Namaste ${payload.patientName} ji! Arogya Care Clinic se reminder hai ki kal ${payload.appointmentDate} ko ${payload.startTime} baje ${payload.doctorName} ke sath aapka clinic appointment scheduled hai. Kripya samay se 10 minute pehle clinic pahunchein aur purane medical records sath layein. Dhanyawad!`
      : `Namaste ${payload.patientName} ji! Arogya Care Clinic se reminder: aaj ${payload.startTime} baje (lagbhag 2 ghante baad) ${payload.doctorName} ke sath aapka appointment hai. Kripya clinic samay par pahunchein. Dhanyawad!`;

    const result: ReminderResult = {
      success: true,
      channel: 'VOICE',
      recipientMasked: payload.patientPhoneMasked,
      scriptGenerated: script,
      timestamp: new Date().toISOString(),
    };

    rootLogger.info(`[ReminderOutbound] Simulated Outbound IVR Call Dispatched`, {
      channel: 'VOICE',
      reminderType: payload.reminderType,
      appointmentId: payload.appointmentId,
      recipient: payload.patientPhoneMasked,
      doctor: payload.doctorName,
      scriptLength: script.length,
    });

    this.sentReminders.push(result);
    return result;
  }

  public async sendReminderSms(payload: ReminderPayload): Promise<ReminderResult> {
    const is24h = payload.reminderType === '24h';
    const script = is24h
      ? `Arogya Clinic Reminder: Namaste ${payload.patientName}! Kal ${payload.appointmentDate} ko ${payload.startTime} baje ${payload.doctorName} ke sath aapka appointment confirm hai. Please 10 min pehle reach karein. Purane records sath layein.`
      : `Arogya Clinic Alert: Namaste ${payload.patientName}! Aaj ${payload.startTime} baje (2 hrs baad) ${payload.doctorName} ke sath appointment hai. Kripya clinic samay par pahunchein.`;

    const result: ReminderResult = {
      success: true,
      channel: 'SMS',
      recipientMasked: payload.patientPhoneMasked,
      scriptGenerated: script,
      timestamp: new Date().toISOString(),
    };

    rootLogger.info(`[ReminderOutbound] Simulated SMS Notification Dispatched`, {
      channel: 'SMS',
      reminderType: payload.reminderType,
      appointmentId: payload.appointmentId,
      recipient: payload.patientPhoneMasked,
      doctor: payload.doctorName,
      smsSnippet: script.slice(0, 60),
    });

    this.sentReminders.push(result);
    return result;
  }

  public getSentReminders(): ReminderResult[] {
    return [...this.sentReminders];
  }

  public clear(): void {
    this.sentReminders = [];
  }
}

export const globalReminderProvider = new SimulatedReminderProvider();
