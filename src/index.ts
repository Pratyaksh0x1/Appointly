/**
 * Appointly Server Entrypoint
 * Stateless Backend Service connecting Neon PostgreSQL, Gnani Voice AI,
 * and Doctor Dashboard with Server-Sent Events (SSE).
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

// Connected SSE clients for live dashboard broadcast
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
      description: 'Get list of doctors, their specialties, consultation fees, and available days at the clinic.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_available_slots',
      description: 'Get list of available open time slots for a specific doctor on a specific date (YYYY-MM-DD).',
      parameters: {
        type: 'object',
        properties: {
          doctorId: { type: 'string', description: 'Doctor ID, e.g. dr_sharma, dr_priya, dr_rajesh, dr_ananya' },
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
      description: 'Atomically book an appointment slot. Can only be called after patient confirms doctor, date, and time.',
      parameters: {
        type: 'object',
        properties: {
          doctorId: { type: 'string', description: 'Doctor ID' },
          date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
          startTime: { type: 'string', description: 'Slot start time in HH:mm format, e.g. 09:30, 10:00' },
          patientName: { type: 'string', description: 'Full name of the patient' },
          patientPhone: { type: 'string', description: '10-digit Indian phone number of the patient' },
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
      // Broadcast to doctor dashboard instantly
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

  return http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    try {
      // 1. Health check
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

      // 2. Doctor listing
      if (req.method === 'GET' && pathname === '/api/doctors') {
        const doctors = await db.getDoctors();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(doctors));
        return;
      }

      // 3. Available slots
      if (req.method === 'GET' && pathname === '/api/slots') {
        const doctorId = parsedUrl.searchParams.get('doctorId') || 'dr_sharma';
        const date = parsedUrl.searchParams.get('date') || new Date().toISOString().slice(0, 10);
        const slots = await db.getAvailableSlots(doctorId, date);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ doctorId, date, availableSlots: slots }));
        return;
      }

      // 4. Appointments listing
      if (req.method === 'GET' && pathname === '/api/appointments') {
        const doctorId = parsedUrl.searchParams.get('doctorId') || undefined;
        const date = parsedUrl.searchParams.get('date') || undefined;
        const appointments = await db.getAppointments(doctorId, date);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(appointments));
        return;
      }

      // 5. Callback requests
      if (req.method === 'GET' && pathname === '/api/callbacks') {
        const callbacks = await db.getCallbackRequests();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(callbacks));
        return;
      }

      // 6. Cost meter summary
      if (req.method === 'GET' && pathname === '/api/cost') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(globalCostMeter.getSummary()));
        return;
      }

      // 7. Server-Sent Events (SSE) for live Doctor Dashboard
      if (req.method === 'GET' && pathname === '/api/dashboard/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write('event: connected\ndata: {"message": "Connected to Appointly real-time stream"}\n\n');
        sseClients.add(res);

        req.on('close', () => {
          sseClients.delete(res);
        });
        return;
      }

      // 8. Conversational Chat & Appointment Booking API
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
            const messages: ChatMessage[] = [
              {
                role: 'system',
                content:
                  'You are Appointly, an empathetic, highly professional clinic voice assistant for Arogya Care Clinic. ' +
                  'You speak in natural Hinglish (Hindi + English code-switching). ' +
                  'Your mission is to help patients book doctor appointments, check timings, fees, and doctor availability. ' +
                  'RULE 1: You CANNOT write to the database. You MUST call tools (get_clinic_doctors, get_available_slots, book_appointment). ' +
                  'RULE 2: When an appointment is booked, tell the patient clearly: doctor name, date, start time, and duration (in minutes). ' +
                  'Use natural conversational speech tags like <pauses> when appropriate.',
              },
              { role: 'user', content: userText },
            ];

            const llmRes = await llmClient.generateResponse(messages, APPOINTMENT_TOOLS, callId, {
              patientPhone,
            });

            let finalReply = llmRes.message.content || '';

            // Handle tool calls generated by LLM
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
                  finalReply =
                    'Hamare clinic me Dr. Ramesh Sharma (General Medicine), Dr. Priya Patel (Pediatrician), ' +
                    'Dr. Rajesh Kumar (Cardiologist), aur Dr. Ananya Iyer (Dermatologist) uplabdh hain. ' +
                    'Aap kinke liye appointment book karna chahenge?';
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

      // 9. Static UI / Minimalist Doctor Dashboard
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const dashboardHtmlPath = path.resolve('public/index.html');
        if (fs.existsSync(dashboardHtmlPath)) {
          const html = fs.readFileSync(dashboardHtmlPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }
      }

      // 10. Static Logo file
      if (req.method === 'GET' && pathname === '/logo.jpg') {
        const logoPath = path.resolve('public/logo.jpg');
        if (fs.existsSync(logoPath)) {
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

  // Verify and initialize DB
  await db.initialize();
  const doctors = await db.getDoctors();
  rootLogger.info(`Connected to database. Loaded ${doctors.length} clinic doctors.`, {
    doctorsCount: doctors.length,
  });

  const server = createServer();
  return new Promise<http.Server>((resolve) => {
    server.listen(env.PORT, () => {
      rootLogger.info(`Appointly Voice Agent & Dashboard running at http://localhost:${env.PORT}`);
      resolve(server);
    });
  });
}

// Auto-start if executed directly
if (process.argv[1] && process.argv[1].includes('index')) {
  startApp().catch((err) => {
    rootLogger.error('Failed to start Appointly server:', err);
    process.exit(1);
  });
}
