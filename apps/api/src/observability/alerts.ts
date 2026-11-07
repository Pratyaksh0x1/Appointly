/**
 * Appointly Realtime Alerting Engine
 * Evaluates error rates, stage latencies, SLO violations, and credit depletion.
 * Dispatches structured alert events to logs and optional external webhooks.
 */

import { rootLogger } from '../logger/logger.js';
import { globalMetrics, MetricsSummaryJson } from './metrics.js';
import { AppointlyEvents } from './events.js';

export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface AlertDefinition {
  id: string;
  name: string;
  severity: AlertSeverity;
  message: string;
  triggeredAt: string;
  metricValue: number | string;
  thresholdValue: number | string;
  acknowledged?: boolean;
}

export interface AlertEngineConfig {
  errorRateThresholdPercent: number; // default: 5.0%
  p95LatencyThresholdMs: number; // default: 2000ms
  creditDepletionThresholdPercent: number; // default: 90%
  webhookUrl?: string;
}

export class AlertEngine {
  private config: AlertEngineConfig;
  private activeAlerts: Map<string, AlertDefinition> = new Map();
  private alertHistory: AlertDefinition[] = [];

  constructor(config: Partial<AlertEngineConfig> = {}) {
    this.config = {
      errorRateThresholdPercent:
        config.errorRateThresholdPercent ??
        Number(process.env.ALERT_ERROR_RATE_THRESHOLD_PERCENT || 5.0),
      p95LatencyThresholdMs:
        config.p95LatencyThresholdMs ?? Number(process.env.ALERT_LATENCY_THRESHOLD_MS || 2000),
      creditDepletionThresholdPercent:
        config.creditDepletionThresholdPercent ??
        Number(process.env.ALERT_CREDIT_THRESHOLD_PERCENT || 90.0),
      webhookUrl: config.webhookUrl || process.env.ALERT_WEBHOOK_URL,
    };
  }

  /**
   * Evaluates current system metrics against configured SLO & health thresholds.
   */
  public evaluateSystemHealth(customSummary?: MetricsSummaryJson): AlertDefinition[] {
    const summary = customSummary || globalMetrics.getJsonSummary();
    const currentAlerts: AlertDefinition[] = [];

    // 1. Error Rate Alert (Threshold: > 5%)
    const totalRequests = summary.calls.total;
    const failedCalls = summary.calls.error + summary.calls.dropped;
    if (totalRequests >= 5) {
      const errorRatePercent = Math.round((failedCalls / totalRequests) * 1000) / 10;
      if (errorRatePercent > this.config.errorRateThresholdPercent) {
        currentAlerts.push(
          this.triggerAlert({
            id: 'HIGH_ERROR_RATE',
            name: 'High Error Rate Detected',
            severity: 'CRITICAL',
            message: `Call error rate of ${errorRatePercent}% exceeded threshold of ${this.config.errorRateThresholdPercent}%`,
            metricValue: `${errorRatePercent}%`,
            thresholdValue: `${this.config.errorRateThresholdPercent}%`,
          })
        );
      } else {
        this.resolveAlert('HIGH_ERROR_RATE');
      }
    }

    // 2. Latency SLO Breach Alert (Threshold: p95 turn latency > 2000ms)
    if (summary.latencies.turn_total.count >= 5) {
      const p95Latency = summary.latencies.turn_total.p95;
      if (p95Latency > this.config.p95LatencyThresholdMs) {
        currentAlerts.push(
          this.triggerAlert({
            id: 'HIGH_TURN_LATENCY',
            name: 'P95 Turn Latency SLO Breach',
            severity: 'WARNING',
            message: `Voice turn P95 latency reached ${p95Latency}ms, breaching the ${this.config.p95LatencyThresholdMs}ms SLO target`,
            metricValue: `${p95Latency}ms`,
            thresholdValue: `${this.config.p95LatencyThresholdMs}ms`,
          })
        );
      } else {
        this.resolveAlert('HIGH_TURN_LATENCY');
      }
    }

    // 3. Credit Depletion Alert (Threshold: > 90% budget consumed)
    const budgetLimit = 5000;
    const creditsBurned = summary.credits.total_credits_burned;
    const budgetPercent = Math.round((creditsBurned / budgetLimit) * 1000) / 10;
    if (budgetPercent >= this.config.creditDepletionThresholdPercent) {
      currentAlerts.push(
        this.triggerAlert({
          id: 'CREDIT_DEPLETION_WARNING',
          name: 'Credit Budget Running Low',
          severity: 'CRITICAL',
          message: `${creditsBurned} of ${budgetLimit} Gnani credits burned (${budgetPercent}%). Immediate top-up recommended.`,
          metricValue: `${budgetPercent}%`,
          thresholdValue: `${this.config.creditDepletionThresholdPercent}%`,
        })
      );
    } else {
      this.resolveAlert('CREDIT_DEPLETION_WARNING');
    }

    return currentAlerts;
  }

  /**
   * Triggers an alert, writes structured log, and dispatches to webhook if configured.
   */
  public triggerAlert(alertParams: Omit<AlertDefinition, 'triggeredAt'>): AlertDefinition {
    const existing = this.activeAlerts.get(alertParams.id);
    const alert: AlertDefinition = {
      ...alertParams,
      triggeredAt: existing ? existing.triggeredAt : new Date().toISOString(),
    };

    this.activeAlerts.set(alert.id, alert);
    this.alertHistory.unshift(alert);
    if (this.alertHistory.length > 100) this.alertHistory.pop();

    rootLogger.warn(`[Alert Triggered] ${alert.name}: ${alert.message}`, {
      event: AppointlyEvents.ALERT_TRIGGERED,
      alertId: alert.id,
      severity: alert.severity,
      metricValue: alert.metricValue,
      thresholdValue: alert.thresholdValue,
    });

    // Asynchronously dispatch webhook (never block event loop)
    if (this.config.webhookUrl) {
      this.dispatchWebhook(alert).catch((err) => {
        rootLogger.warn('[Alert Webhook] Failed to deliver alert payload', {
          alertId: alert.id,
          error: (err as Error).message,
        });
      });
    }

    return alert;
  }

  public resolveAlert(alertId: string): void {
    if (this.activeAlerts.has(alertId)) {
      const alert = this.activeAlerts.get(alertId)!;
      this.activeAlerts.delete(alertId);

      rootLogger.info(`[Alert Resolved] ${alert.name}`, {
        event: AppointlyEvents.ALERT_RESOLVED,
        alertId,
      });
    }
  }

  public getActiveAlerts(): AlertDefinition[] {
    return Array.from(this.activeAlerts.values());
  }

  public getAlertHistory(): AlertDefinition[] {
    return [...this.alertHistory];
  }

  private async dispatchWebhook(alert: AlertDefinition): Promise<void> {
    if (!this.config.webhookUrl) return;

    try {
      const payload = {
        app: 'Appointly Voice Assistant',
        event: 'alert.triggered',
        timestamp: new Date().toISOString(),
        alert,
      };

      await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // Swallowed safely to preserve reliability
    }
  }

  public reset(): void {
    this.activeAlerts.clear();
    this.alertHistory = [];
  }
}

export const globalAlertEngine = new AlertEngine();
