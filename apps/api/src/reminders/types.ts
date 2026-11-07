/**
 * Outbound Reminder System Types
 * Behind a provider interface so real telephony/SMS (Twilio, Gupshup, Gnani) can be added cleanly.
 */

export interface ReminderPayload {
  appointmentId: string;
  patientName: string;
  patientPhoneMasked: string;
  doctorName: string;
  appointmentDate: string;
  startTime: string;
  durationMinutes?: number;
  reminderType: '24h' | '2h';
  scheduledFor: Date;
}

export interface ReminderResult {
  success: boolean;
  channel: 'VOICE' | 'SMS';
  recipientMasked: string;
  scriptGenerated: string;
  timestamp: string;
  error?: string;
}

export interface IReminderProvider {
  sendReminderCall(payload: ReminderPayload): Promise<ReminderResult>;
  sendReminderSms(payload: ReminderPayload): Promise<ReminderResult>;
}
