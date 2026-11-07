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

let isShuttingDown = false;
const sseClients = new Set<http.ServerResponse>();

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
      broadcastDashboardEvent('new_appointment', bookingResult.appointment);
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
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Request-ID, X-Call-ID'
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    try {
      // 1. Liveness Probe (/healthz)
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

      // 2. Readiness Probe (/readyz)
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

      // 4. Doctor listing
      if (req.method === 'GET' && pathname === '/api/doctors') {
        const doctors = await db.getDoctors();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(doctors));
        return;
      }

      // 4b. Doctor Schedule Configuration (Doctor decides consultation timing e.g. 17:00 - 22:00)
      const scheduleMatch = pathname.match(/^\/api\/doctors\/([^/]+)\/schedule$/);
      if ((req.method === 'PUT' || req.method === 'POST') && scheduleMatch) {
        const doctorId = scheduleMatch[1];
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const raw = JSON.parse(body || '{}');
            const parsed = doctorScheduleUpdateSchema.safeParse(raw);
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

            // Broadcast real-time schedule update event to connected dashboards
            broadcastDashboardEvent('doctor_schedule_updated', {
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
        });
        return;
      }

      // 5. Available slots
      if (req.method === 'GET' && pathname === '/api/slots') {
        const doctorId = parsedUrl.searchParams.get('doctorId') || 'dr_sharma';
        const date = parsedUrl.searchParams.get('date') || new Date().toISOString().slice(0, 10);
        const slots = await db.getAvailableSlots(doctorId, date);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ doctorId, date, availableSlots: slots }));
        return;
      }

      // 6. Appointments listing
      if (req.method === 'GET' && pathname === '/api/appointments') {
        const doctorId = parsedUrl.searchParams.get('doctorId') || undefined;
        const date = parsedUrl.searchParams.get('date') || undefined;
        const appointments = await db.getAppointments(doctorId, date);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(appointments));
        return;
      }

      // 7. Callback requests
      if (req.method === 'GET' && pathname === '/api/callbacks') {
        const callbacks = await db.getCallbackRequests();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(callbacks));
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
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            const parsed = body ? JSON.parse(body) : {};
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
        });
        return;
      }

      // 8c. Realtime Voice Latency Telemetry Metrics
      if (req.method === 'GET' && pathname === '/api/voice/latency') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(globalLatencyCollector.getStats()));
        return;
      }

      // 8d. Realtime Voice Pipeline Test Page
      if (req.method === 'GET' && (pathname === '/voice-test' || pathname === '/voice-test.html')) {
        const candidatePaths = [
          path.resolve(process.cwd(), 'apps/dashboard/public/voice-test.html'),
          path.resolve(process.cwd(), 'public/voice-test.html'),
        ];
        const htmlPath = candidatePaths.find((p) => fs.existsSync(p));
        if (htmlPath) {
          const html = fs.readFileSync(htmlPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }
      }

      // 9. Server-Sent Events (SSE) for live Doctor Dashboard
      if (req.method === 'GET' && pathname === '/api/dashboard/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(
          'event: connected\ndata: {"message": "Connected to Appointly real-time stream"}\n\n'
        );
        sseClients.add(res);

        req.on('close', () => {
          sseClients.delete(res);
        });
        return;
      }

      // 10. Conversational Chat & Appointment Booking API
      if (req.method === 'POST' && pathname === '/api/chat') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            const userText = data.text || '';
            const callId = data.callId || `call_${Date.now()}`;
            const patientPhone = data.phone || '9876543210';

            // NON-NEGOTIABLE RULE 4: Code-level deterministic emergency check
            const emergency = checkEmergency(userText);
            if (emergency.isEmergency) {
              broadcastDashboardEvent('emergency_alert', {
                callId,
                patientPhoneMasked: patientPhone,
                matchedKeywords: emergency.matchedKeywords,
                timestamp: new Date(),
              });

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  replyText: emergency.escalationMessage,
                  isEmergency: true,
                  matchedKeywords: emergency.matchedKeywords,
                })
              );
              return;
            }

            // LLM Reasoning & Tool Calling
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
                  'You are Appointly, an empathetic, highly professional clinic voice assistant for Arogya Care Clinic. ' +
                  'You speak in natural Hinglish (Hindi + English code-switching). ' +
                  'Your mission is to help patients book doctor appointments, check timings, fees, and doctor availability.\n\n' +
                  'CURRENT CLINIC DOCTORS & OPD TIMINGS:\n' +
                  doctorScheduleDesc +
                  '\n\n' +
                  'CRITICAL DOCTOR TIMING RULES:\n' +
                  '1. Each doctor configures their specific consultation hours (e.g. Dr. Sharma may sit 17:00 to 22:00 / 5 PM to 10 PM).\n' +
                  "2. NEVER offer or book a slot outside the doctor's active working hours.\n" +
                  "3. If a patient asks for an unavailable time (e.g. asking for 10:00 AM when doctor works 17:00 to 22:00), politely explain the doctor's active timing in Hinglish and suggest available evening slots.\n" +
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

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                replyText: finalReply,
                callId,
                creditsSummary: globalCostMeter.getSummary(),
              })
            );
          } catch (chatErr) {
            rootLogger.error('Error in /api/chat:', chatErr);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(chatErr) }));
          }
        });
        return;
      }

      // 11. Minimalist Doctor Dashboard Static Serving
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const candidatePaths = [
          path.resolve(process.cwd(), 'apps/dashboard/index.html'),
          path.resolve(process.cwd(), 'public/index.html'),
        ];
        const htmlPath = candidatePaths.find((p) => fs.existsSync(p));
        if (htmlPath) {
          const html = fs.readFileSync(htmlPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }
      }

      // 12. Static Logo
      if (req.method === 'GET' && pathname === '/logo.jpg') {
        const candidatePaths = [
          path.resolve(process.cwd(), 'apps/dashboard/public/logo.jpg'),
          path.resolve(process.cwd(), 'public/logo.jpg'),
        ];
        const logoPath = candidatePaths.find((p) => fs.existsSync(p));
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
  const doctors = await db.getDoctors();
  rootLogger.info(`Connected to database. Loaded ${doctors.length} clinic doctors.`, {
    doctorsCount: doctors.length,
  });

  const server = createServer();

  // Graceful shutdown registration
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
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
