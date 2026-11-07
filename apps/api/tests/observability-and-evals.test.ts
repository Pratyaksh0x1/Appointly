/**
 * Phase 9: Observability, Prometheus Metrics, Alerting Engine & Eval Validation Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { MetricsCollector } from '../src/observability/metrics.js';
import { AlertEngine } from '../src/observability/alerts.js';
import { AppointlyEvents } from '../src/observability/events.js';
import { createServer } from '../src/index.js';

describe('Phase 9: Observability, Metrics & Telemetry Suite', () => {
  let metrics: MetricsCollector;
  let alerts: AlertEngine;

  beforeEach(() => {
    metrics = new MetricsCollector();
    alerts = new AlertEngine({
      errorRateThresholdPercent: 5.0,
      p95LatencyThresholdMs: 2000,
      creditDepletionThresholdPercent: 90.0,
    });
  });

  describe('MetricsCollector Engine', () => {
    it('should accurately track calls and calculate completion rates', () => {
      metrics.startCall();
      metrics.endCall('completed');

      metrics.startCall();
      metrics.endCall('completed');

      metrics.startCall();
      metrics.endCall('dropped');

      metrics.startCall();
      metrics.endCall('emergency');

      const summary = metrics.getJsonSummary();
      expect(summary.calls.total).toBe(4);
      expect(summary.calls.completed).toBe(2);
      expect(summary.calls.dropped).toBe(1);
      expect(summary.calls.emergency).toBe(1);
      expect(summary.calls.error).toBe(0);
    });

    it('should compute stage latency percentiles (min, p50, p90, p95, max, avg)', () => {
      // Feed a distribution of latencies
      const sampleLatencies = [200, 300, 350, 400, 450, 500, 600, 750, 900, 1500];
      for (const lat of sampleLatencies) {
        metrics.recordTurnLatency({
          turn_total_ms: lat,
          stt_ms: Math.round(lat * 0.3),
          llm_first_token_ms: Math.round(lat * 0.4),
          tts_first_audio_ms: Math.round(lat * 0.3),
        });
      }

      const summary = metrics.getJsonSummary();
      const stats = summary.latencies.turn_total;

      expect(stats.count).toBe(10);
      expect(stats.min).toBe(200);
      expect(stats.max).toBe(1500);
      expect(stats.p50).toBe(500); // 10 * 0.5 = index 5 (500)
      expect(stats.p95).toBe(1500);
      expect(stats.avg).toBe(595);
      expect(summary.slo.p95_turn_latency_ms).toBe(1500);
      expect(summary.slo.latency_slo_status).toBe('MET');
    });

    it('should calculate availability and detect SLO breaches', () => {
      // 1000 requests, 2 errors -> 99.8% availability (breaches 99.9% target)
      for (let i = 0; i < 998; i++) {
        metrics.recordRequest(false);
      }
      metrics.recordRequest(true);
      metrics.recordRequest(true);

      const summary = metrics.getJsonSummary();
      expect(summary.slo.availability_target_percent).toBe(99.9);
      expect(summary.slo.availability_actual_percent).toBe(99.8);
      expect(summary.slo.availability_status).toBe('BREACHED');
    });

    it('should format metrics in standard Prometheus Text Exposition format (v0.0.4)', () => {
      metrics.startCall();
      metrics.endCall('completed');
      metrics.recordBooking(true);
      metrics.recordBooking(false, 'SLOT_FULL');
      metrics.recordTurnLatency({ turn_total_ms: 320 });
      metrics.recordCallCredits(15);

      const promOutput = metrics.toPrometheusFormat();

      expect(promOutput).toContain('# HELP appointly_calls_total');
      expect(promOutput).toContain('# TYPE appointly_calls_total counter');
      expect(promOutput).toContain('appointly_calls_total{status="completed"} 1');
      expect(promOutput).toContain('appointly_bookings_total{status="succeeded"} 1');
      expect(promOutput).toContain('appointly_bookings_total{status="failed"} 1');
      expect(promOutput).toContain('appointly_turn_latency_ms{quantile="0.5"} 320');
      expect(promOutput).toContain('appointly_turn_latency_ms{quantile="0.95"} 320');
      expect(promOutput).toContain('appointly_credits_burned_total 15');
    });
  });

  describe('AlertEngine Logic & Threshold Checking', () => {
    it('should trigger HIGH_ERROR_RATE alert when error rate > 5%', () => {
      // 10 calls, 2 errors = 20% error rate (threshold 5%)
      for (let i = 0; i < 8; i++) {
        metrics.startCall();
        metrics.endCall('completed');
      }
      for (let i = 0; i < 2; i++) {
        metrics.startCall();
        metrics.endCall('error');
      }

      const triggeredAlerts = alerts.evaluateSystemHealth(metrics.getJsonSummary());
      expect(triggeredAlerts.length).toBeGreaterThanOrEqual(1);

      const errorRateAlert = triggeredAlerts.find((a) => a.id === 'HIGH_ERROR_RATE');
      expect(errorRateAlert).toBeDefined();
      expect(errorRateAlert?.severity).toBe('CRITICAL');
      expect(errorRateAlert?.metricValue).toBe('20%');
    });

    it('should trigger HIGH_TURN_LATENCY alert when P95 latency > 2000ms', () => {
      // 10 turns with extreme latencies exceeding 2000ms
      for (let i = 0; i < 10; i++) {
        metrics.recordTurnLatency({ turn_total_ms: 2500 + i * 50 });
      }

      const triggeredAlerts = alerts.evaluateSystemHealth(metrics.getJsonSummary());
      const latencyAlert = triggeredAlerts.find((a) => a.id === 'HIGH_TURN_LATENCY');

      expect(latencyAlert).toBeDefined();
      expect(latencyAlert?.severity).toBe('WARNING');
      expect(alerts.getActiveAlerts().some((a) => a.id === 'HIGH_TURN_LATENCY')).toBe(true);
    });

    it('should trigger CREDIT_DEPLETION_WARNING when budget >= 90% burned', () => {
      // 4600 credits burned out of 5000 budget = 92%
      metrics.recordCallCredits(4600);

      const triggeredAlerts = alerts.evaluateSystemHealth(metrics.getJsonSummary());
      const creditAlert = triggeredAlerts.find((a) => a.id === 'CREDIT_DEPLETION_WARNING');

      expect(creditAlert).toBeDefined();
      expect(creditAlert?.severity).toBe('CRITICAL');
      expect(creditAlert?.metricValue).toBe('92%');
    });

    it('should auto-resolve alert when metrics return to healthy thresholds', () => {
      // First trigger alert
      alerts.triggerAlert({
        id: 'HIGH_ERROR_RATE',
        name: 'High Error Rate Detected',
        severity: 'CRITICAL',
        message: 'High error rate',
        metricValue: '20%',
        thresholdValue: '5%',
      });
      expect(alerts.getActiveAlerts().length).toBe(1);

      // Now pass healthy summary (0 errors out of 10)
      for (let i = 0; i < 10; i++) {
        metrics.startCall();
        metrics.endCall('completed');
      }

      alerts.evaluateSystemHealth(metrics.getJsonSummary());
      expect(alerts.getActiveAlerts().length).toBe(0);
    });
  });

  describe('HTTP Observability Endpoints (/metrics & /api/alerts)', () => {
    let server: http.Server;
    const testPort = 3199;
    const baseUrl = `http://127.0.0.1:${testPort}`;

    beforeEach(async () => {
      process.env.USE_IN_MEMORY_DB = 'true';
      process.env.USE_MOCK_PROVIDERS = 'true';
      server = createServer();
      await new Promise<void>((resolve) => server.listen(testPort, resolve));
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('GET /metrics should return Prometheus format by default', async () => {
      const res = await fetch(`${baseUrl}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');

      const text = await res.text();
      expect(text).toContain('# HELP appointly_calls_total');
      expect(text).toContain('# TYPE appointly_calls_total counter');
      expect(text).toContain('appointly_slo_availability_ratio');
    });

    it('GET /metrics?format=json should return JSON format', async () => {
      const res = await fetch(`${baseUrl}/metrics?format=json`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');

      const data = (await res.json()) as any;
      expect(data.service).toBe('appointly-voice-agent');
      expect(data.slo).toBeDefined();
      expect(data.slo.availability_target_percent).toBe(99.9);
      expect(data.latencies).toBeDefined();
    });

    it('GET /api/metrics should return JSON telemetry summary for dashboard', async () => {
      const res = await fetch(`${baseUrl}/api/metrics`);
      expect(res.status).toBe(200);

      const data = (await res.json()) as any;
      expect(data.calls).toBeDefined();
      expect(data.bookings).toBeDefined();
      expect(data.credits).toBeDefined();
    });

    it('GET /api/alerts should return active alerts and incident history', async () => {
      const res = await fetch(`${baseUrl}/api/alerts`);
      expect(res.status).toBe(200);

      const data = (await res.json()) as any;
      expect(Array.isArray(data.activeAlerts)).toBe(true);
      expect(Array.isArray(data.history)).toBe(true);
    });
  });
});
