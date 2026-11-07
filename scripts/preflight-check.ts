/**
 * Appointly Pre-Flight Verification Script
 * Validates database connectivity, route endpoints, static assets,
 * audio cache warmup, and core safety evaluations in a single command.
 */

import http from 'http';
import { getEnv } from '../apps/api/src/config/env.js';
import { getDatabaseClient } from '../apps/api/src/db/index.js';
import { runEvalSuite } from './eval-harness.js';

interface CheckItem {
  name: string;
  passed: boolean;
  details: string;
}

async function probeHttp(port: number, path: string): Promise<{ status: number; ok: boolean }> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}${path}`, (res) => {
      resolve({ status: res.statusCode || 500, ok: (res.statusCode || 500) < 400 });
    });
    req.on('error', () => resolve({ status: 0, ok: false }));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve({ status: 408, ok: false });
    });
  });
}

async function main() {
  console.log('\n======================================================');
  console.log('  🚀 APPOINTLY PRE-FLIGHT SYSTEM VERIFICATION');
  console.log('======================================================\n');

  const checks: CheckItem[] = [];
  const env = getEnv();

  // 1. Environment Configuration
  checks.push({
    name: 'Environment Validation',
    passed: !!env.DATABASE_URL && !!env.PORT,
    details: `Port: ${env.PORT}, Mode: ${env.NODE_ENV}, DB: ${env.USE_IN_MEMORY_DB ? 'In-Memory' : 'Neon Serverless'}`,
  });

  // 2. Database Connection & Roster Check
  try {
    const db = getDatabaseClient();
    await db.initialize();
    const doctors = await db.getDoctors();
    checks.push({
      name: 'Database & Doctor Roster',
      passed: doctors.length > 0,
      details: `Loaded ${doctors.length} doctors (${doctors.map((d) => d.name).join(', ')})`,
    });
  } catch (err: any) {
    checks.push({
      name: 'Database & Doctor Roster',
      passed: false,
      details: `Database connection failed: ${err.message}`,
    });
  }

  // 3. HTTP Server Probes (if running on PORT)
  const port = env.PORT || 3000;
  const probeEndpoints = [
    { path: '/healthz', expected: 200 },
    { path: '/readyz', expected: 200 },
    { path: '/metrics', expected: 200 },
    { path: '/api/doctors', expected: 200 },
    { path: '/', expected: 200 },
    { path: '/voice-test', expected: 200 },
  ];

  for (const ep of probeEndpoints) {
    const res = await probeHttp(port, ep.path);
    checks.push({
      name: `HTTP Probe: ${ep.path}`,
      passed: res.status === ep.expected,
      details: res.ok ? `Status: ${res.status} OK` : `Status: ${res.status} (Server probe failed)`,
    });
  }

  // 4. Conversational AI Evaluation Harness
  console.log('⏳ Running 61-Scenario Conversational AI Eval Harness...');
  try {
    const evalReport = await runEvalSuite();
    checks.push({
      name: 'Evaluation Harness Pass Rate',
      passed: evalReport.passRate >= 90,
      details: `Pass Rate: ${evalReport.passRate}% (${evalReport.passedCount}/${evalReport.totalScenarios})`,
    });
    checks.push({
      name: 'Strict Emergency Triage Safety',
      passed: evalReport.emergencyPassRate === 100,
      details: `Emergency Escalation Rate: ${evalReport.emergencyPassRate}% (Target: 100%)`,
    });
    checks.push({
      name: 'Zero Unavailable Slot Bookings',
      passed: evalReport.unavailableSlotBookedCount === 0,
      details: `Unavailable Slots Booked: ${evalReport.unavailableSlotBookedCount} (Target: 0)`,
    });
  } catch (err: any) {
    checks.push({
      name: 'Conversational AI Evaluation',
      passed: false,
      details: `Eval harness failed to execute: ${err.message}`,
    });
  }

  // Print Summary
  console.log('\n======================================================');
  console.log('  📋 PRE-FLIGHT CHECK RESULTS');
  console.log('======================================================');

  let allPassed = true;
  for (const c of checks) {
    const icon = c.passed ? '✅' : '❌';
    if (!c.passed) allPassed = false;
    console.log(`${icon} [${c.name}]: ${c.details}`);
  }
  console.log('======================================================\n');

  if (allPassed) {
    console.log('🎉 ALL PRE-FLIGHT CHECKS PASSED! System is 100% production-ready.\n');
    process.exit(0);
  } else {
    console.log('⚠️ Some pre-flight checks failed. Please review the errors above.\n');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal preflight error:', err);
  process.exit(1);
});
