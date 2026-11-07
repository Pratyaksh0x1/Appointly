/**
 * Appointly Server Entrypoint
 * Stateless Backend Service connecting Neon PostgreSQL, Gnani Voice AI,
 * and Doctor Dashboard with Server-Sent Events (SSE).
 * Implements /healthz, /readyz, and graceful shutdown.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { getEnv, getSafePublicConfig } from './config/env.js';
import { rootLogger } from './logger/logger.js';
import { getDatabaseClient } from './db/index.js';
import { globalCostMeter } from './cost/cost-meter.js';
import { checkEmergency, EMERGENCY_ESCALATION_HINGLISH } from './safety/emergency.js';
import { EvonLLMClient, ToolDefinition, ChatMessage } from './services/evon-llm-client.js';
import { GnaniTTSClient } from './services/tts-client.js';
import { doctorScheduleUpdateSchema } from '@appointly/shared';
import { createVoiceSessionToken } from './voice/session-manager.js';
import { globalLatencyCollector } from './voice/timing-metrics.js';
import { initAudioCache } from './voice/audio-cache.js';
import { setupVoiceWebSocketServer } from './voice/ws-pipeline.js';
import {
  signDoctorToken,
  verifyDoctorToken,
  verifyGoogleCredential,
  requireDoctorAuth,
  CLINIC_DOCTOR_ROSTER,
} from './auth/jwt-auth.js';
import { emitOutboxEvent, startOutboxRelay, stopOutboxRelay } from './db/outbox-relay.js';
import { startReminderJob, stopReminderJob } from './reminders/reminder-job.js';
import { applySecurityHeaders } from './middleware/security-headers.js';
import { globalRateLimiter } from './middleware/rate-limiter.js';
import { handleIdempotencyPreRequest } from './middleware/idempotency.js';
import { readAndSanitizeJsonBody } from './middleware/sanitizer.js';
import {
  startTranscriptRetentionWorker,
  stopTranscriptRetentionWorker,
} from './services/transcript-retention.js';
import { globalMetrics } from './observability/metrics.js';
import { processLiveVoiceTurn, isGeminiConfigured } from './services/gemini-service.js';
import { globalAlertEngine } from './observability/alerts.js';
import { AppointlyEvents } from './observability/events.js';
import { Doctor } from './types/index.js';

let isShuttingDown = false;
const sseClients = new Set<http.ServerResponse>();

export function findStaticFile(relativeSubpaths: string[]): string | null {
  const baseDirs = [
    process.cwd(),
    path.resolve(process.cwd(), '..'),
    path.resolve(process.cwd(), '../..'),
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '../..'),
    path.resolve(__dirname, '../../..'),
  ];
  for (const sub of relativeSubpaths) {
    for (const base of baseDirs) {
      const candidate = path.resolve(base, sub);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export function broadcastDashboardEvent(eventType: string, data: unknown) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

const APPOINTMENT_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_clinic_doctors',
      description:
        'Get list of doctors, their specialties, consultation fees, and available days at the clinic.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_available_slots',
      description:
        'Get list of available open time slots for a specific doctor on a specific date (YYYY-MM-DD).',
      parameters: {
        type: 'object',
        properties: {
          doctorId: {
            type: 'string',
            description: 'Doctor ID, e.g. dr_sharma, dr_priya, dr_rajesh, dr_ananya',
          },
          date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
        },
        required: ['doctorId', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_appointment',
      description:
        'Atomically book an appointment slot. Can only be called after patient confirms doctor, date, and time.',
      parameters: {
        type: 'object',
        properties: {
          doctorId: { type: 'string', description: 'Doctor ID' },
          date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
          startTime: {
            type: 'string',
            description: 'Slot start time in HH:mm format, e.g. 09:30, 10:00',
          },
          patientName: { type: 'string', description: 'Full name of the patient' },
          patientPhone: {
            type: 'string',
            description: '10-digit Indian phone number of the patient',
          },
        },
        required: ['doctorId', 'date', 'startTime', 'patientName', 'patientPhone'],
      },
    },
  },
];

async function handleToolExecution(
  toolName: string,
  args: Record<string, unknown>,
  callId: string
): Promise<{ result: unknown; isBookingSuccess?: boolean }> {
  const db = getDatabaseClient();

  if (toolName === 'get_clinic_doctors') {
    const doctors = await db.getDoctors();
    return { result: doctors };
  }

  if (toolName === 'get_available_slots') {
    const { doctorId, date } = args as { doctorId: string; date: string };
    const slots = await db.getAvailableSlots(doctorId, date);
    return { result: { doctorId, date, availableSlots: slots } };
  }

  if (toolName === 'book_appointment') {
    const { doctorId, date, startTime, patientName, patientPhone } = args as {
      doctorId: string;
      date: string;
      startTime: string;
      patientName: string;
      patientPhone: string;
    };

    const idempotencyKey = `idem_${callId}_${doctorId}_${date}_${startTime}`;

    const bookingResult = await db.bookAppointment({
      doctorId,
      date,
      startTime,
      patientName,
      patientPhone,
      idempotencyKey,
    });

    if (bookingResult.success && bookingResult.appointment) {
      await emitOutboxEvent('new_appointment', bookingResult.appointment as any);
      return { result: bookingResult, isBookingSuccess: true };
    }

    return { result: bookingResult, isBookingSuccess: false };
  }

  return { result: { error: `Unknown tool: ${toolName}` } };
}

export function createServer() {
  const env = getEnv();
  const db = getDatabaseClient();
  const llmClient = new EvonLLMClient();
  const ttsClient = new GnaniTTSClient();

  const server = http.createServer(async (req, res) => {
    // 1. Strict Security Headers & CORS Allowlist
    const handledOptions = applySecurityHeaders(req, res);
    if (handledOptions) {
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    try {
      // 1. Liveness Probe (/healthz) - bypasses rate limiting for orchestrators
      if (req.method === 'GET' && pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            time: new Date().toISOString(),
            uptimeSeconds: Math.round(process.uptime()),
          })
        );
        return;
      }

      // 2. Readiness Probe (/readyz) - bypasses rate limiting for orchestrators
      if (req.method === 'GET' && pathname === '/readyz') {
        if (isShuttingDown) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'not_ready', reason: 'Server is shutting down' }));
          return;
        }

        try {
          const doctors = await db.getDoctors();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'ready',
              database: env.USE_IN_MEMORY_DB ? 'in-memory-mock' : 'neon-postgres',
              neonBranch: env.NEON_BRANCH || 'unknown',
              doctorsLoaded: doctors.length,
            })
          );
        } catch (dbErr) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'not_ready', error: String(dbErr) }));
        }
        return;
      }

      // 3. Sliding Window Rate Limiting (per-IP and per-session)
      const allowed = globalRateLimiter.checkRateLimit(req, res);
      if (!allowed) {
        return;
      }

      // 4. Idempotency Check on mutating methods (POST, PUT, DELETE, PATCH)
      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method || '')) {
        const handledIdempotency = handleIdempotencyPreRequest(req, res);
        if (handledIdempotency) {
          return;
        }
      }

      // 3. Detailed Health Check (/health)
      if (req.method === 'GET' && pathname === '/health') {
        const doctors = await db.getDoctors();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'healthy',
            service: 'Appointly Voice Backend',
            database: env.USE_IN_MEMORY_DB ? 'in-memory-mock' : 'neon-postgres',
            neonBranch: env.NEON_BRANCH || 'unknown',
            doctorsLoaded: doctors.length,
            creditsSummary: globalCostMeter.getSummary(),
            config: getSafePublicConfig(),
          })
        );
        return;
      }

      // 3b. Observability: Prometheus & JSON Metrics (/metrics)
      if (req.method === 'GET' && pathname === '/metrics') {
        const acceptHeader = req.headers['accept'] || '';
        const wantsJson =
          acceptHeader.includes('application/json') ||
          parsedUrl.searchParams.get('format') === 'json';

        if (wantsJson) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(globalMetrics.getJsonSummary(), null, 2));
        } else {
          res.writeHead(200, {
            'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
          });
          res.end(globalMetrics.toPrometheusFormat());
        }
        return;
      }

      // 3c. Observability: JSON Metrics for Dashboard (/api/metrics)
      if (req.method === 'GET' && pathname === '/api/metrics') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(globalMetrics.getJsonSummary(), null, 2));
        return;
      }

      // 3d. Observability: Active Alerts & History (/api/alerts)
      if (req.method === 'GET' && pathname === '/api/alerts') {
        globalAlertEngine.evaluateSystemHealth();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            {
              activeAlerts: globalAlertEngine.getActiveAlerts(),
              history: globalAlertEngine.getAlertHistory(),
            },
            null,
            2
          )
        );
        return;
      }

      // 4. Doctor listing
      if (req.method === 'GET' && pathname === '/api/doctors') {
        const doctors = await db.getDoctors();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(doctors));
        return;
      }

      // 4-CONFIG. Public Auth Configuration (exposes Google Client ID safely)
      if (req.method === 'GET' && pathname === '/api/config/auth') {
        const googleClientId = process.env.GOOGLE_CLIENT_ID || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            googleClientId,
            hasGoogleAuth: Boolean(googleClientId && googleClientId.length > 5),
          })
        );
        return;
      }

      // 4-CLINIC. Clinic Profile & Onboarding Settings
      if (req.method === 'GET' && pathname === '/api/clinic/profile') {
        const profile = db.getClinicProfile ? await db.getClinicProfile() : {};
        const doctors = await db.getDoctors();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ profile, doctors }));
        return;
      }

      if (
        (req.method === 'POST' || req.method === 'PUT') &&
        (pathname === '/api/clinic/onboarding' || pathname === '/api/clinic/settings')
      ) {
        const bodyRes = await readAndSanitizeJsonBody(req, res);
        if (!bodyRes.success) return;
        try {
          const { clinicName, clinicPhone, clinicAddress, openingTime, closingTime, doctors } =
            bodyRes.data || {};

          let updatedProfile = {};
          if (db.updateClinicProfile) {
            updatedProfile = await db.updateClinicProfile({
              clinicName: clinicName || 'Arogya Care Clinic',
              clinicPhone: clinicPhone || '+91 98765 43210',
              clinicAddress: clinicAddress || '42, Green Glen Layout, Bellandur, Bengaluru',
              openingTime: openingTime || '09:00',
              closingTime: closingTime || '22:00',
              onboardingCompleted: true,
            });
          }

          let updatedDoctors: Doctor[] = [];
          if (Array.isArray(doctors) && doctors.length > 0 && db.setDoctors) {
            const formattedDoctors: Doctor[] = doctors.map((d: any, idx: number) => ({
              id: d.id || `dr_${(d.name || `doctor_${idx + 1}`).toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
              name: d.name || `Dr. Doctor ${idx + 1}`,
              specialty: d.specialty || 'General Medicine',
              workingHoursStart: d.workingHoursStart || '09:00',
              workingHoursEnd: d.workingHoursEnd || '18:00',
              durationMinutes: Number(d.durationMinutes) || 30,
              fee: Number(d.fee) || 500,
              activeDays: Array.isArray(d.activeDays) && d.activeDays.length > 0
                ? d.activeDays
                : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
              availableSlots: d.availableSlots || [],
            }));
            updatedDoctors = await db.setDoctors(formattedDoctors);
          } else {
            updatedDoctors = await db.getDoctors();
          }

          await emitOutboxEvent('clinic_updated', {
            profile: updatedProfile,
            doctorsCount: updatedDoctors.length,
            timestamp: new Date().toISOString(),
          });

          rootLogger.info('[Clinic] Clinic profile & onboarding schedule updated successfully', {
            clinicName,
            doctorsCount: updatedDoctors.length,
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: true,
              message: 'Clinic profile & doctor schedule saved successfully',
              profile: updatedProfile,
              doctors: updatedDoctors,
            })
          );
        } catch (err: any) {
          rootLogger.error('[Clinic] Failed to update clinic settings:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'CLINIC_UPDATE_FAILED', message: String(err) }));
        }
        return;
      }

      // 4-AUTH. Authentication Endpoints for Doctor Dashboard
      if (req.method === 'POST' && pathname === '/api/auth/google') {
        const bodyRes = await readAndSanitizeJsonBody(req, res);
        if (!bodyRes.success) return;
        try {
          const { credential } = bodyRes.data || {};
          const doctorUser = await verifyGoogleCredential(credential);
          const token = signDoctorToken(doctorUser);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, token, doctor: doctorUser }));
        } catch (err: any) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'GOOGLE_AUTH_FAILED',
              message: String(err.message || err),
            })
          );
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/auth/dev-login') {
        const bodyRes = await readAndSanitizeJsonBody(req, res);
        if (!bodyRes.success) return;
        try {
          const { doctorId } = bodyRes.data || {};
          const targetId = doctorId || 'dr_sharma';
          const doctorUser = CLINIC_DOCTOR_ROSTER[targetId] || CLINIC_DOCTOR_ROSTER['dr_sharma'];
          const token = signDoctorToken(doctorUser);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, token, doctor: doctorUser }));
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'DEV_LOGIN_FAILED', message: String(err) }));
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/api/auth/me') {
        const doctor = requireDoctorAuth(req, res);
        if (!doctor) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, doctor }));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/auth/logout') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Logged out successfully' }));
        return;
      }

      // 4b. Doctor Schedule Configuration (Protected: requires doctor auth)
      const scheduleMatch = pathname.match(/^\/api\/doctors\/([^/]+)\/schedule$/);
      if ((req.method === 'PUT' || req.method === 'POST') && scheduleMatch) {
        const authDoctor = requireDoctorAuth(req, res);
        if (!authDoctor) return;

        const doctorId = scheduleMatch[1];
        const bodyRes = await readAndSanitizeJsonBody(req, res);
        if (!bodyRes.success) return;
        try {
          const parsed = doctorScheduleUpdateSchema.safeParse(bodyRes.data);
          if (!parsed.success) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'INVALID_SCHEDULE_DATA',
                details: parsed.error.format(),
              })
            );
            return;
          }

          const updatedDoc = await db.updateDoctorSchedule(doctorId, parsed.data);

          // Broadcast real-time schedule update event to connected dashboards via outbox
          await emitOutboxEvent('doctor_schedule_updated', {
            doctorId,
            doctor: updatedDoc,
            timestamp: new Date().toISOString(),
          });

          rootLogger.info(`Doctor schedule updated for ${doctorId}`, {
            doctorId,
            workingHoursStart: updatedDoc.workingHoursStart,
            workingHoursEnd: updatedDoc.workingHoursEnd,
            activeDays: updatedDoc.activeDays,
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: true,
              message: `Schedule for ${updatedDoc.name} updated to ${updatedDoc.workingHoursStart} - ${updatedDoc.workingHoursEnd}.`,
              doctor: updatedDoc,
            })
          );
        } catch (err) {
          rootLogger.error('Error updating doctor schedule:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
        return;
      }

      // 5. Available slots (Public: patient voice needs to query available times)
      if (req.method === 'GET' && pathname === '/api/slots') {
        const doctorId = parsedUrl.searchParams.get('doctorId') || 'dr_sharma';
        const date = parsedUrl.searchParams.get('date') || new Date().toISOString().slice(0, 10);
        const slots = await db.getAvailableSlots(doctorId, date);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ doctorId, date, availableSlots: slots }));
        return;
      }

      // 6. Appointments listing (Protected: requires doctor auth)
      if (req.method === 'GET' && pathname === '/api/appointments') {
        const authDoctor = requireDoctorAuth(req, res);
        if (!authDoctor) return;

        const doctorId = parsedUrl.searchParams.get('doctorId') || undefined;
        const date = parsedUrl.searchParams.get('date') || undefined;
        const appointments = await db.getAppointments(doctorId, date);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(appointments));
        return;
      }

      // 6b. Reschedule Appointment (Protected: requires doctor auth)
      const rescheduleMatch = pathname.match(/^\/api\/appointments\/([^/]+)\/reschedule$/);
      if (req.method === 'PUT' && rescheduleMatch) {
        const authDoctor = requireDoctorAuth(req, res);
        if (!authDoctor) return;

        const appointmentId = rescheduleMatch[1];
        const bodyRes = await readAndSanitizeJsonBody(req, res);
        if (!bodyRes.success) return;
        try {
          const { newDate, newStartTime } = bodyRes.data || {};
          if (!newDate || !newStartTime) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'MISSING_DATA',
                message: 'newDate and newStartTime are required.',
              })
            );
            return;
          }

          const result = await db.rescheduleAppointment(appointmentId, newDate, newStartTime);
          if (result.success && result.appointment) {
            await emitOutboxEvent('appointment_rescheduled', result.appointment as any);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          }
        } catch (err: any) {
          rootLogger.error('Error rescheduling appointment:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
        return;
      }

      // 6c. Cancel Appointment (Protected: requires doctor auth)
      const cancelMatch = pathname.match(/^\/api\/appointments\/([^/]+)\/cancel$/);
      if (req.method === 'PUT' && cancelMatch) {
        const authDoctor = requireDoctorAuth(req, res);
        if (!authDoctor) return;

        const appointmentId = cancelMatch[1];
        const bodyRes = await readAndSanitizeJsonBody(req, res);
        if (!bodyRes.success) return;
        try {
          const { reason } = bodyRes.data || {};
          const result = await db.cancelAppointment(appointmentId, reason);
          if (result.success) {
            await emitOutboxEvent('appointment_cancelled', { appointmentId, reason });
          }
          res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          rootLogger.error('Error cancelling appointment:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
        return;
      }

      // 6d. Complete Appointment (Protected: requires doctor auth)
      const completeMatch = pathname.match(/^\/api\/appointments\/([^/]+)\/complete$/);
      if (req.method === 'PUT' && completeMatch) {
        const authDoctor = requireDoctorAuth(req, res);
        if (!authDoctor) return;

        const appointmentId = completeMatch[1];
        try {
          const result = await db.completeAppointment(appointmentId);
          if (result.success) {
            await emitOutboxEvent('appointment_completed', { appointmentId });
          }
          res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          rootLogger.error('Error completing appointment:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
        return;
      }

      // 7. Callback requests (Protected: requires doctor auth)
      if (req.method === 'GET' && pathname === '/api/callbacks') {
        const authDoctor = requireDoctorAuth(req, res);
        if (!authDoctor) return;

        const callbacks = await db.getCallbackRequests();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(callbacks));
        return;
      }

      // 7b. Resolve Callback Request (Protected: requires doctor auth)
      const resolveCallbackMatch = pathname.match(/^\/api\/callbacks\/([^/]+)\/resolve$/);
      if (req.method === 'PUT' && resolveCallbackMatch) {
        const authDoctor = requireDoctorAuth(req, res);
        if (!authDoctor) return;

        const callbackId = resolveCallbackMatch[1];
        try {
          const result = await db.resolveCallbackRequest(callbackId);
          if (result.success) {
            await emitOutboxEvent('callback_resolved', { callbackId });
          }
          res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          rootLogger.error('Error resolving callback request:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
        return;
      }

      // 7c. Doctor Call Summaries (Protected: requires doctor auth)
      if (req.method === 'GET' && pathname === '/api/calls') {
        const authDoctor = requireDoctorAuth(req, res);
        if (!authDoctor) return;

        const limit = parseInt(parsedUrl.searchParams.get('limit') || '25', 10);
        const summaries = await db.getCallSummaries(limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(summaries));
        return;
      }

      // 8. Cost meter summary
      if (req.method === 'GET' && pathname === '/api/cost') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(globalCostMeter.getSummary()));
        return;
      }

      // 8b. Realtime Voice Session Token Generator (Rate-limited, short-lived token)
      if (req.method === 'POST' && pathname === '/api/voice/session') {
        const bodyRes = await readAndSanitizeJsonBody(req, res);
        if (!bodyRes.success) return;
        try {
          const parsed = bodyRes.data || {};
          const clientIp =
            (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
            req.socket.remoteAddress ||
            '127.0.0.1';
          const tokenResult = createVoiceSessionToken(clientIp, {
            patientPhone: parsed.patientPhone,
            doctorId: parsed.doctorId,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(tokenResult));
        } catch (err: any) {
          if (err.message && err.message.includes('TOO_MANY_REQUESTS')) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'RATE_LIMIT_EXCEEDED',
                message: 'Too many requests. Please wait before creating a new session.',
              })
            );
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(err) }));
          }
        }
        return;
      }

      // 8c. Realtime Voice Latency Telemetry Metrics
      if (req.method === 'GET' && pathname === '/api/voice/latency') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(globalLatencyCollector.getStats()));
        return;
      }

      // 8d. Realtime Voice Pipeline & Live Patient Call Page
      if (
        req.method === 'GET' &&
        (pathname === '/call' ||
          pathname === '/call.html' ||
          pathname === '/voice' ||
          pathname === '/voice-test' ||
          pathname === '/voice-test.html')
      ) {
        const htmlPath = findStaticFile([
          'apps/dashboard/public/live-call.html',
          'public/live-call.html',
          'apps/dashboard/public/voice-test.html',
          'public/voice-test.html',
        ]);
        if (htmlPath) {
          const html = fs.readFileSync(htmlPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }
      }

      // 8e. Gemini Live Voice Call Turn Endpoint
      if (req.method === 'POST' && (pathname === '/api/call/turn' || pathname === '/api/voice/turn')) {
        const bodyRes = await readAndSanitizeJsonBody(req, res);
        if (!bodyRes.success) return;
        try {
          const { userText, callId, history } = bodyRes.data || {};
          const turnResult = await processLiveVoiceTurn({
            userText: userText || '',
            callId: callId || `call_${Date.now()}`,
            history: history || [],
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(turnResult));
        } catch (err: any) {
          rootLogger.error('Error in live call turn:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
        return;
      }

      // 8f. Gemini AI Status Probe
      if (req.method === 'GET' && pathname === '/api/config/gemini') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            configured: isGeminiConfigured(),
            model: 'gemini-2.5-flash',
          })
        );
        return;
      }

      // 9. Server-Sent Events (SSE) for live Doctor Dashboard (Protected: requires doctor auth)
      if (req.method === 'GET' && pathname === '/api/dashboard/stream') {
        const authDoctor = requireDoctorAuth(req, res);
        if (!authDoctor) return;

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(
          `event: connected\ndata: {"message": "Connected to Appointly real-time stream as ${authDoctor.name}"}\n\n`
        );
        sseClients.add(res);

        req.on('close', () => {
          sseClients.delete(res);
        });
        return;
      }

      // 10. Conversational Chat & Appointment Booking API
      if (req.method === 'POST' && pathname === '/api/chat') {
        const chatStartTs = Date.now();
        const bodyRes = await readAndSanitizeJsonBody(req, res);
        if (!bodyRes.success) return;
        try {
          const data = bodyRes.data || {};
          const userText = data.text || '';
          const callId = data.callId || `call_${Date.now()}`;
          const patientPhone = data.phone || '9876543210';

          // NON-NEGOTIABLE RULE 4: Code-level deterministic emergency check
          const emergency = checkEmergency(userText);
          if (emergency.isEmergency) {
            globalMetrics.recordEmergency();
            await emitOutboxEvent('emergency_alert', {
              callId,
              patientPhoneMasked: patientPhone,
              matchedKeywords: emergency.matchedKeywords,
              timestamp: new Date().toISOString(),
            });

            const turnTotalMs = Date.now() - chatStartTs;
            globalMetrics.recordTurnLatency({ turn_total_ms: turnTotalMs });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                replyText: emergency.escalationMessage,
                isEmergency: true,
                matchedTriggers: emergency.matchedKeywords,
                callId,
              })
            );
            return;
          }

          // LLM Reasoning & Tool Calling
          const clinicProfile = db.getClinicProfile ? await db.getClinicProfile() : { clinicName: 'Clinic' };
          const clinicName = clinicProfile.clinicName || 'Clinic';
          const clinicDoctors = await db.getDoctors();
          const doctorScheduleDesc = clinicDoctors
            .map(
              (d) =>
                `- ${d.name} (${d.specialty}): OPD Timing ${d.workingHoursStart} se ${d.workingHoursEnd} on ${d.activeDays.join(', ')} (Fee: ₹${d.fee})`
            )
            .join('\n');

          const messages: ChatMessage[] = [
            {
              role: 'system',
              content:
                `You are Appointly, an empathetic, highly professional clinic voice assistant for "${clinicName}". ` +
                'You speak in natural Hinglish (Hindi + English code-switching). ' +
                'Your mission is to help patients book doctor appointments, check timings, fees, and doctor availability.\n\n' +
                'CURRENT CLINIC DOCTORS & OPD TIMINGS:\n' +
                doctorScheduleDesc +
                '\n\n' +
                'CRITICAL DOCTOR TIMING RULES:\n' +
                '1. Each doctor configures their specific consultation hours.\n' +
                "2. NEVER offer or book a slot outside the doctor's active working hours.\n" +
                "3. If a patient asks for an unavailable time, politely explain the doctor's active timing in Hinglish and suggest available slots.\n" +
                '4. RULE 1: You CANNOT write directly to the database. You MUST call tools (get_clinic_doctors, get_available_slots, book_appointment).\n' +
                '5. RULE 2: When an appointment is booked, tell the patient clearly: doctor name, date, start time, and duration (in minutes). Only say "booked" after the DB tool confirms with success.\n' +
                'Use natural conversational speech tags like <pauses> when appropriate.',
            },
            { role: 'user', content: userText },
          ];

          const llmRes = await llmClient.generateResponse(messages, APPOINTMENT_TOOLS, callId, {
            patientPhone,
          });

          let finalReply = llmRes.message.content || '';

          if (llmRes.message.tool_calls && llmRes.message.tool_calls.length > 0) {
            for (const tc of llmRes.message.tool_calls) {
              const args = JSON.parse(tc.function.arguments);
              const toolExecution = await handleToolExecution(tc.function.name, args, callId);

              if (tc.function.name === 'book_appointment') {
                const bookingRes = toolExecution.result as {
                  success: boolean;
                  appointment?: {
                    doctorName: string;
                    appointmentDate: string;
                    startTime: string;
                    durationMinutes: number;
                  };
                  message: string;
                  error?: string;
                };

                if (bookingRes.success && bookingRes.appointment) {
                  finalReply =
                    `Aapka appointment confirm ho gaya hai! <pauses> ` +
                    `Doctor: ${bookingRes.appointment.doctorName}, ` +
                    `Date: ${bookingRes.appointment.appointmentDate}, ` +
                    `Samay: ${bookingRes.appointment.startTime}, ` +
                    `Duration: ${bookingRes.appointment.durationMinutes} minutes. ` +
                    `Aapko confirmation message bhej diya gaya hai.`;
                } else {
                  finalReply = `Maaf kijiye, ${bookingRes.message}`;
                }
              } else if (tc.function.name === 'get_clinic_doctors') {
                const docs = (toolExecution.result as any[]) || clinicDoctors;
                const docOverview = docs
                  .map(
                    (d) =>
                      `${d.name} (${d.specialty}, Timing: ${d.workingHoursStart} - ${d.workingHoursEnd}, Fee: ₹${d.fee})`
                  )
                  .join('; ');
                finalReply = `Hamare clinic me ye doctors uplabdh hain: ${docOverview}. Aap kinke sath appointment lena chahenge?`;
              } else if (tc.function.name === 'get_available_slots') {
                const slotRes = toolExecution.result as {
                  doctorId: string;
                  date: string;
                  availableSlots: string[];
                };
                if (slotRes.availableSlots && slotRes.availableSlots.length > 0) {
                  const sample = slotRes.availableSlots.slice(0, 6).join(', ');
                  finalReply = `${slotRes.date} ke liye ye time slots uplabdh hain: ${sample}. Aapko kaunsa time theek rahega?`;
                } else {
                  finalReply = `Maaf kijiye, is date (${slotRes.date}) par koi slot uplabdh nahi hai. Kripya doctor ke clinic timing me kisi aur din ya samay ka slot chuniye.`;
                }
              }
            }
          }

          const turnTotalMs = Date.now() - chatStartTs;
          globalMetrics.recordTurnLatency({ turn_total_ms: turnTotalMs });
          globalAlertEngine.evaluateSystemHealth();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              replyText: finalReply,
              callId,
              creditsSummary: globalCostMeter.getSummary(),
            })
          );
        } catch (chatErr) {
          globalMetrics.recordFailure('API_CHAT_ERROR');
          globalAlertEngine.evaluateSystemHealth();
          rootLogger.error('Error in /api/chat:', chatErr);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(chatErr) }));
        }
        return;
      }

      // 11. Minimalist Doctor Dashboard Static Serving
      if (
        req.method === 'GET' &&
        (pathname === '/' || pathname === '/index.html' || pathname === '/dashboard')
      ) {
        const htmlPath = findStaticFile([
          'apps/dashboard/index.html',
          'public/index.html',
          'dashboard/index.html',
          'index.html',
        ]);
        if (htmlPath) {
          const html = fs.readFileSync(htmlPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }
      }

      // 12. Static Logo
      if (req.method === 'GET' && pathname === '/logo.jpg') {
        const logoPath = findStaticFile([
          'apps/dashboard/public/logo.jpg',
          'public/logo.jpg',
          'dashboard/public/logo.jpg',
          'logo.jpg',
        ]);
        if (logoPath) {
          const img = fs.readFileSync(logoPath);
          res.writeHead(200, { 'Content-Type': 'image/jpeg' });
          res.end(img);
          return;
        }
      }

      // Default 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Endpoint not found' }));
    } catch (err) {
      rootLogger.error('Unhandled server error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  setupVoiceWebSocketServer(server);

  return server;
}

export async function startApp() {
  const env = getEnv();
  const db = getDatabaseClient();

  rootLogger.info('Starting Appointly Server...', {
    env: env.NODE_ENV,
    port: env.PORT,
    database: env.USE_IN_MEMORY_DB ? 'in-memory' : 'neon-postgres',
    neonBranch: env.NEON_BRANCH,
  });

  await db.initialize();
  await initAudioCache();
  startOutboxRelay(1000);
  startReminderJob(5000);
  startTranscriptRetentionWorker();
  const doctors = await db.getDoctors();
  rootLogger.info(`Connected to database. Loaded ${doctors.length} clinic doctors.`, {
    doctorsCount: doctors.length,
  });

  const server = createServer();

  // Graceful shutdown registration
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    stopOutboxRelay();
    stopReminderJob();
    stopTranscriptRetentionWorker();
    rootLogger.info(`Received ${signal}. Initiating graceful shutdown...`);

    // Notify connected SSE clients
    for (const client of sseClients) {
      try {
        client.write('event: shutdown\ndata: {"message": "Server shutting down"}\n\n');
        client.end();
      } catch {
        // ignore
      }
    }
    sseClients.clear();

    server.close(async () => {
      rootLogger.info('HTTP server closed. Draining database connection pool...');
      try {
        await db.close();
        rootLogger.info('Database pool closed. Appointly shutdown complete.');
        process.exit(0);
      } catch (err) {
        rootLogger.error('Error closing database pool during shutdown:', err);
        process.exit(1);
      }
    });

    // Force exit if not drained within 5 seconds
    setTimeout(() => {
      rootLogger.error('Graceful shutdown timeout exceeded. Forcefully exiting.');
      process.exit(1);
    }, 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return new Promise<http.Server>((resolve) => {
    server.listen(env.PORT, () => {
      rootLogger.info(`Appointly Voice Agent & Dashboard running at http://localhost:${env.PORT}`);
      resolve(server);
    });
  });
}

if (process.argv[1] && process.argv[1].includes('index')) {
  startApp().catch((err) => {
    rootLogger.error('Failed to start Appointly server:', err);
    process.exit(1);
  });
}
