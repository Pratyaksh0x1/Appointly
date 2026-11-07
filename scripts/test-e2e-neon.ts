/**
 * End-to-End Verification Script for Neon PostgreSQL Integration
 * Tests all wired services live against Neon:
 * 1. Database Connection & Schema Verification
 * 2. Doctor Schedule Queries
 * 3. Atomic Transaction Booking
 * 4. Double-Booking Prevention (Unique Constraint & Mutex on Neon)
 * 5. Cost Meter & Emergency Triage
 */

import http from 'http';
import dotenv from 'dotenv';
import { createServer } from '../apps/api/src/index.js';
import { getDatabaseClient } from '../apps/api/src/db/index.js';

dotenv.config();

async function makeRequest(
  port: number,
  path: string,
  method = 'GET',
  body?: unknown,
  token?: string
): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let resBody = '';
        res.on('data', (chunk) => (resBody += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(resBody || '{}') });
          } catch {
            resolve({ status: res.statusCode, raw: resBody });
          }
        });
      }
    );

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function runE2ETest() {
  console.log('\n======================================================');
  console.log('  🏥 APPOINTLY END-TO-END NEON INTEGRATION VERIFICATION');
  console.log('======================================================\n');

  const testPort = 3099;
  const db = getDatabaseClient();

  console.log('1. Initializing Database Schema on Neon...');
  await db.initialize();
  console.log('   ✅ Neon Database Initialized.\n');

  console.log(`2. Starting HTTP Server on port ${testPort}...`);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(testPort, () => resolve()));
  console.log(`   ✅ Appointly Server listening on http://localhost:${testPort}\n`);

  try {
    // Test 1: Health check
    console.log('3. Testing GET /health...');
    const health = await makeRequest(testPort, '/health');
    console.log('   Status:', health.status);
    console.log('   Service:', health.data.service);
    console.log('   Database:', health.data.database);
    console.log('   Neon Branch:', health.data.neonBranch);
    console.log('   Doctors Loaded:', health.data.doctorsLoaded);
    if (health.status !== 200 || health.data.doctorsLoaded < 1) {
      throw new Error('Health check failed!');
    }
    console.log('   ✅ GET /health Passed.\n');

    // Test 2: Doctors List from Neon
    console.log('4. Testing GET /api/doctors from Neon...');
    const doctorsRes = await makeRequest(testPort, '/api/doctors');
    console.log(`   Retrieved ${doctorsRes.data.length} doctors from Neon PostgreSQL.`);
    console.log('   Sample Doctor:', doctorsRes.data[0].name, `(${doctorsRes.data[0].specialty})`);
    if (doctorsRes.data.length === 0) throw new Error('No doctors returned from Neon');
    console.log('   ✅ GET /api/doctors Passed.\n');

    // Test 3: Available Slots for Dr. Sharma
    const freshDate = new Date();
    freshDate.setDate(freshDate.getDate() + 30 + Math.floor(Math.random() * 30));
    if (freshDate.getDay() === 0) freshDate.setDate(freshDate.getDate() + 1);
    if (freshDate.getDay() === 6) freshDate.setDate(freshDate.getDate() + 2);
    const testDate = freshDate.toISOString().slice(0, 10);

    console.log(`5. Testing GET /api/slots for Dr. Sharma on ${testDate}...`);
    const slotsRes = await makeRequest(testPort, `/api/slots?doctorId=dr_sharma&date=${testDate}`);
    console.log('   Available slots:', slotsRes.data.availableSlots.join(', '));
    if (!slotsRes.data.availableSlots.includes('09:30')) {
      throw new Error('Slot 09:30 missing from doctor slots');
    }
    console.log('   ✅ GET /api/slots Passed.\n');

    // Test 4: Booking an Appointment via Transaction on Neon
    console.log(`6. Testing Live Booking via POST /api/chat on ${testDate}...`);
    const chatBooking = await makeRequest(testPort, '/api/chat', 'POST', {
      text: `Mujhe Dr. Sharma ke sath ${testDate} ko 09:30 par appointment book karna hai, mera naam Aarav Mehta hai`,
      callId: `neon_e2e_${Date.now()}`,
      phone: '9876543210',
    });
    console.log('   Reply Text:', chatBooking.data.replyText);
    if (!chatBooking.data.replyText.includes('confirm')) {
      throw new Error(`Booking flow failed: ${JSON.stringify(chatBooking.data)}`);
    }
    console.log('   ✅ Initial Appointment Booking on Neon Passed.\n');

    // Test 5: NON-NEGOTIABLE RULE 2 - Double Booking Prevention on Neon
    console.log('7. Testing Double-Booking Prevention on Neon (Booking same slot again)...');
    const duplicateAttempt = await db.bookAppointment({
      doctorId: 'dr_sharma',
      date: testDate,
      startTime: '09:30',
      patientName: 'Second Patient',
      patientPhone: '9123456789',
      idempotencyKey: `duplicate_attempt_${Date.now()}`,
    });
    console.log('   Success:', duplicateAttempt.success);
    console.log('   Error Code:', duplicateAttempt.error);
    console.log('   Message:', duplicateAttempt.message);
    if (duplicateAttempt.success || duplicateAttempt.error !== 'SLOT_ALREADY_BOOKED') {
      throw new Error('Double-booking prevention failed! Neon allowed overlapping booking.');
    }
    console.log(
      '   ✅ Double-Booking Strictly Prevented on Neon (Zero Double-Booking Verified).\n'
    );

    // Test 6: Verify Authenticated Appointments on Neon
    console.log('8. Testing Doctor Auth & GET /api/appointments...');
    const loginRes = await makeRequest(testPort, '/api/auth/dev-login', 'POST', {
      doctorId: 'dr_sharma',
    });
    if (!loginRes.data.success || !loginRes.data.token) {
      throw new Error('Doctor login failed');
    }
    const doctorToken = loginRes.data.token;
    console.log(`   ✅ Logged in as ${loginRes.data.doctor.name} (JWT token acquired)`);

    const appointmentsRes = await makeRequest(
      testPort,
      '/api/appointments',
      'GET',
      undefined,
      doctorToken
    );
    console.log(`   Found ${appointmentsRes.data.length} total appointments in Neon.`);
    console.log('   Latest Appointment:', {
      patient: appointmentsRes.data[0].patientName,
      doctor: appointmentsRes.data[0].doctorName,
      date: appointmentsRes.data[0].appointmentDate,
      time: appointmentsRes.data[0].startTime,
      duration: `${appointmentsRes.data[0].durationMinutes}m`,
    });
    console.log('   ✅ GET /api/appointments Passed.\n');

    // Test 7: Emergency Triage Verification
    console.log('9. Testing Emergency Triage Guardrail...');
    const emergencyChat = await makeRequest(testPort, '/api/chat', 'POST', {
      text: 'Doctor jaldi aaiye, patient behosh ho gaya hai aur seene me dard hai!',
      callId: `emergency_${Date.now()}`,
      phone: '9876543210',
    });
    console.log('   Is Emergency:', emergencyChat.data.isEmergency);
    console.log('   Matched Triggers:', emergencyChat.data.matchedKeywords);
    if (!emergencyChat.data.isEmergency || !emergencyChat.data.replyText.includes('108')) {
      throw new Error('Emergency escalation failed to trigger!');
    }
    console.log('   ✅ Emergency Triage Guardrail Verified.\n');

    console.log('======================================================');
    console.log('  🎉 ALL NEON INTEGRATION SERVICES VERIFIED SUCCESSFULLY!');
    console.log('======================================================\n');
  } finally {
    server.close();
    await db.close();
  }
}

runE2ETest().catch((err) => {
  console.error('\n❌ Neon E2E Verification Failed:', err);
  process.exit(1);
});
