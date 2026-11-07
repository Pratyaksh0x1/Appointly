/**
 * Appointly Metrics Collector & Prometheus Exposition Engine
 * Collects high-fidelity real-time telemetry across calls, bookings, failure types,
 * stage latencies (STT, LLM, TTS, Turn Total), credit consumption, and SLO tracking.
 */

export interface StageLatencyRecord {
  stt_ms: number;
  llm_first_token_ms: number;
  llm_total_ms: number;
  tts_first_audio_ms: number;
  turn_total_ms: number;
  timestamp: number;
}

export interface LatencyStats {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

export interface MetricsSummaryJson {
  service: string;
  uptime_seconds: number;
  timestamp: string;
  slo: {
    availability_target_percent: number;
    availability_actual_percent: number;
    availability_status: 'MET' | 'BREACHED';
    p95_latency_target_ms: number;
    p95_turn_latency_ms: number;
    latency_slo_status: 'MET' | 'BREACHED';
  };
  calls: {
    total: number;
    completed: number;
    dropped: number;
    emergency: number;
    error: number;
    active: number;
  };
  bookings: {
    total: number;
    succeeded: number;
    failed: number;
    conversion_rate_percent: number;
  };
  reschedules: {
    total: number;
    succeeded: number;
    failed: number;
  };
  cancellations: {
    total: number;
    succeeded: number;
    failed: number;
  };
  emergencies: {
    total: number;
  };
  failures_by_type: Record<string, number>;
  credits: {
    total_credits_burned: number;
    total_calls_metered: number;
    avg_credits_per_call: number;
    estimated_cost_inr: number;
  };
  latencies: {
    turn_total: LatencyStats;
    stt: LatencyStats;
    llm_first_token: LatencyStats;
    tts_first_audio: LatencyStats;
  };
}

export class MetricsCollector {
  private startTime = Date.now();

  // Call counters
  private callsTotal = 0;
  private callsCompleted = 0;
  private callsDropped = 0;
  private callsEmergency = 0;
  private callsError = 0;
  private activeCalls = 0;

  // Domain counters
  private bookingsSucceeded = 0;
  private bookingsFailed = 0;
  private reschedulesSucceeded = 0;
  private reschedulesFailed = 0;
  private cancellationsSucceeded = 0;
  private cancellationsFailed = 0;
  private emergenciesTotal = 0;

  // Failures by type
  private failuresByType = new Map<string, number>();

  // Latency samples (sliding window)
  private readonly maxSamples = 2000;
  private sttSamples: number[] = [];
  private llmFirstTokenSamples: number[] = [];
  private llmTotalSamples: number[] = [];
  private ttsFirstAudioSamples: number[] = [];
  private turnTotalSamples: number[] = [];

  // Credits
  private callCredits: number[] = [];
  private totalCreditsBurned = 0;

  // SLO Tracking
  private totalRequests = 0;
  private failedRequests = 0;

  public startCall(): void {
    this.callsTotal++;
    this.activeCalls++;
  }

  public endCall(status: 'completed' | 'dropped' | 'emergency' | 'error'): void {
    if (this.activeCalls > 0) this.activeCalls--;
    if (status === 'completed') this.callsCompleted++;
    else if (status === 'dropped') this.callsDropped++;
    else if (status === 'emergency') this.callsEmergency++;
    else if (status === 'error') this.callsError++;
  }

  public recordBooking(success: boolean, failureReason?: string): void {
    if (success) {
      this.bookingsSucceeded++;
    } else {
      this.bookingsFailed++;
      if (failureReason) {
        this.recordFailure(`BOOKING_${failureReason.toUpperCase()}`);
      }
    }
  }

  public recordReschedule(success: boolean, failureReason?: string): void {
    if (success) {
      this.reschedulesSucceeded++;
    } else {
      this.reschedulesFailed++;
      if (failureReason) {
        this.recordFailure(`RESCHEDULE_${failureReason.toUpperCase()}`);
      }
    }
  }

  public recordCancel(success: boolean, failureReason?: string): void {
    if (success) {
      this.cancellationsSucceeded++;
    } else {
      this.cancellationsFailed++;
      if (failureReason) {
        this.recordFailure(`CANCEL_${failureReason.toUpperCase()}`);
      }
    }
  }

  public recordEmergency(): void {
    this.emergenciesTotal++;
  }

  public recordFailure(failureType: string): void {
    const key = failureType.toUpperCase().replace(/\s+/g, '_');
    const current = this.failuresByType.get(key) || 0;
    this.failuresByType.set(key, current + 1);
  }

  public recordTurnLatency(record: Partial<StageLatencyRecord>): void {
    this.totalRequests++;

    if (record.turn_total_ms !== undefined) {
      this.turnTotalSamples.push(record.turn_total_ms);
      if (this.turnTotalSamples.length > this.maxSamples) this.turnTotalSamples.shift();
    }
    if (record.stt_ms !== undefined) {
      this.sttSamples.push(record.stt_ms);
      if (this.sttSamples.length > this.maxSamples) this.sttSamples.shift();
    }
    if (record.llm_first_token_ms !== undefined) {
      this.llmFirstTokenSamples.push(record.llm_first_token_ms);
      if (this.llmFirstTokenSamples.length > this.maxSamples) this.llmFirstTokenSamples.shift();
    }
    if (record.llm_total_ms !== undefined) {
      this.llmTotalSamples.push(record.llm_total_ms);
      if (this.llmTotalSamples.length > this.maxSamples) this.llmTotalSamples.shift();
    }
    if (record.tts_first_audio_ms !== undefined) {
      this.ttsFirstAudioSamples.push(record.tts_first_audio_ms);
      if (this.ttsFirstAudioSamples.length > this.maxSamples) this.ttsFirstAudioSamples.shift();
    }
  }

  public recordCallCredits(credits: number): void {
    this.totalCreditsBurned += credits;
    this.callCredits.push(credits);
    if (this.callCredits.length > this.maxSamples) this.callCredits.shift();
  }

  public recordRequest(isError: boolean): void {
    this.totalRequests++;
    if (isError) this.failedRequests++;
  }

  private calculateStats(samples: number[]): LatencyStats {
    if (samples.length === 0) {
      return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const count = sorted.length;
    const avg = Math.round(sum / count);

    const percentile = (p: number) => {
      const idx = Math.min(count - 1, Math.floor(count * p));
      return sorted[idx];
    };

    return {
      count,
      min: sorted[0],
      max: sorted[count - 1],
      avg,
      p50: percentile(0.5),
      p90: percentile(0.9),
      p95: percentile(0.95),
      p99: percentile(0.99),
    };
  }

  public getJsonSummary(): MetricsSummaryJson {
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
    const turnTotalStats = this.calculateStats(this.turnTotalSamples);
    const sttStats = this.calculateStats(this.sttSamples);
    const llmStats = this.calculateStats(this.llmFirstTokenSamples);
    const ttsStats = this.calculateStats(this.ttsFirstAudioSamples);

    // Calculate Availability (Target: 99.9%)
    const totalReq = Math.max(1, this.totalRequests);
    const availPercent = Math.round(((totalReq - this.failedRequests) / totalReq) * 10000) / 100;
    const availabilityStatus = availPercent >= 99.9 ? 'MET' : 'BREACHED';

    // Latency SLO (Target: P95 turn latency < 2000 ms)
    const latencySloStatus =
      turnTotalStats.count === 0 || turnTotalStats.p95 <= 2000 ? 'MET' : 'BREACHED';

    // Conversion rate
    const totalBookingAttempts = this.bookingsSucceeded + this.bookingsFailed;
    const conversionRate =
      totalBookingAttempts > 0
        ? Math.round((this.bookingsSucceeded / totalBookingAttempts) * 1000) / 10
        : 0;

    // Credits & Cost
    const totalCalls = this.callCredits.length;
    const avgCreditsPerCall =
      totalCalls > 0 ? Math.round((this.totalCreditsBurned / totalCalls) * 100) / 100 : 0;
    // Estimated cost: 1 Gnani credit ~ approx 0.05 INR
    const estimatedCostInr = Math.round(this.totalCreditsBurned * 0.05 * 100) / 100;

    const failuresObj: Record<string, number> = {};
    for (const [k, v] of this.failuresByType.entries()) {
      failuresObj[k] = v;
    }

    return {
      service: 'appointly-voice-agent',
      uptime_seconds: uptimeSeconds,
      timestamp: new Date().toISOString(),
      slo: {
        availability_target_percent: 99.9,
        availability_actual_percent: availPercent,
        availability_status: availabilityStatus,
        p95_latency_target_ms: 2000,
        p95_turn_latency_ms: turnTotalStats.p95,
        latency_slo_status: latencySloStatus,
      },
      calls: {
        total: this.callsTotal,
        completed: this.callsCompleted,
        dropped: this.callsDropped,
        emergency: this.callsEmergency,
        error: this.callsError,
        active: this.activeCalls,
      },
      bookings: {
        total: totalBookingAttempts,
        succeeded: this.bookingsSucceeded,
        failed: this.bookingsFailed,
        conversion_rate_percent: conversionRate,
      },
      reschedules: {
        total: this.reschedulesSucceeded + this.reschedulesFailed,
        succeeded: this.reschedulesSucceeded,
        failed: this.reschedulesFailed,
      },
      cancellations: {
        total: this.cancellationsSucceeded + this.cancellationsFailed,
        succeeded: this.cancellationsSucceeded,
        failed: this.cancellationsFailed,
      },
      emergencies: {
        total: this.emergenciesTotal,
      },
      failures_by_type: failuresObj,
      credits: {
        total_credits_burned: Math.round(this.totalCreditsBurned * 100) / 100,
        total_calls_metered: totalCalls,
        avg_credits_per_call: avgCreditsPerCall,
        estimated_cost_inr: estimatedCostInr,
      },
      latencies: {
        turn_total: turnTotalStats,
        stt: sttStats,
        llm_first_token: llmStats,
        tts_first_audio: ttsStats,
      },
    };
  }

  /**
   * Generates standard Prometheus Text Exposition Format (version 0.0.4)
   */
  public toPrometheusFormat(): string {
    const summary = this.getJsonSummary();
    const lines: string[] = [];

    // Helper
    const writeMetric = (name: string, type: string, help: string, value: number, labels = '') => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      lines.push(`${name}${labels} ${value}`);
    };

    // Uptime
    writeMetric(
      'appointly_uptime_seconds',
      'gauge',
      'Server process uptime in seconds',
      summary.uptime_seconds
    );

    // SLO
    writeMetric(
      'appointly_slo_availability_ratio',
      'gauge',
      'Calculated service availability ratio',
      summary.slo.availability_actual_percent / 100
    );
    writeMetric(
      'appointly_slo_p95_turn_latency_ms',
      'gauge',
      'P95 turn latency in milliseconds',
      summary.slo.p95_turn_latency_ms
    );

    // Calls Total
    lines.push('# HELP appointly_calls_total Total calls handled by status');
    lines.push('# TYPE appointly_calls_total counter');
    lines.push(`appointly_calls_total{status="completed"} ${summary.calls.completed}`);
    lines.push(`appointly_calls_total{status="dropped"} ${summary.calls.dropped}`);
    lines.push(`appointly_calls_total{status="emergency"} ${summary.calls.emergency}`);
    lines.push(`appointly_calls_total{status="error"} ${summary.calls.error}`);
    lines.push(`appointly_calls_active ${summary.calls.active}`);

    // Bookings Total
    lines.push('# HELP appointly_bookings_total Total bookings attempted by status');
    lines.push('# TYPE appointly_bookings_total counter');
    lines.push(`appointly_bookings_total{status="succeeded"} ${summary.bookings.succeeded}`);
    lines.push(`appointly_bookings_total{status="failed"} ${summary.bookings.failed}`);

    // Reschedules Total
    lines.push('# HELP appointly_reschedules_total Total reschedules attempted');
    lines.push('# TYPE appointly_reschedules_total counter');
    lines.push(`appointly_reschedules_total{status="succeeded"} ${summary.reschedules.succeeded}`);
    lines.push(`appointly_reschedules_total{status="failed"} ${summary.reschedules.failed}`);

    // Cancellations Total
    lines.push('# HELP appointly_cancellations_total Total cancellations attempted');
    lines.push('# TYPE appointly_cancellations_total counter');
    lines.push(
      `appointly_cancellations_total{status="succeeded"} ${summary.cancellations.succeeded}`
    );
    lines.push(`appointly_cancellations_total{status="failed"} ${summary.cancellations.failed}`);

    // Emergencies
    writeMetric(
      'appointly_emergencies_total',
      'counter',
      'Total emergency escalations triggered',
      summary.emergencies.total
    );

    // Failures by type
    if (Object.keys(summary.failures_by_type).length > 0) {
      lines.push('# HELP appointly_failures_total Total system failures by classification');
      lines.push('# TYPE appointly_failures_total counter');
      for (const [fType, count] of Object.entries(summary.failures_by_type)) {
        lines.push(`appointly_failures_total{type="${fType}"} ${count}`);
      }
    }

    // Credits
    writeMetric(
      'appointly_credits_burned_total',
      'counter',
      'Total Gnani AI credits burned',
      summary.credits.total_credits_burned
    );
    writeMetric(
      'appointly_credits_per_call_avg',
      'gauge',
      'Average credits burned per call',
      summary.credits.avg_credits_per_call
    );

    // Latency Quantiles
    const writeQuantiles = (metricName: string, help: string, stats: LatencyStats) => {
      lines.push(`# HELP ${metricName} ${help}`);
      lines.push(`# TYPE ${metricName} summary`);
      lines.push(`${metricName}{quantile="0.5"} ${stats.p50}`);
      lines.push(`${metricName}{quantile="0.9"} ${stats.p90}`);
      lines.push(`${metricName}{quantile="0.95"} ${stats.p95}`);
      lines.push(`${metricName}{quantile="0.99"} ${stats.p99}`);
      lines.push(`${metricName}_sum ${stats.avg * stats.count}`);
      lines.push(`${metricName}_count ${stats.count}`);
    };

    writeQuantiles(
      'appointly_turn_latency_ms',
      'Voice turn end-of-speech to audio playback latency',
      summary.latencies.turn_total
    );
    writeQuantiles(
      'appointly_stt_latency_ms',
      'STT inference stage latency',
      summary.latencies.stt
    );
    writeQuantiles(
      'appointly_llm_first_token_latency_ms',
      'LLM first token / orchestrator stage latency',
      summary.latencies.llm_first_token
    );
    writeQuantiles(
      'appointly_tts_first_audio_latency_ms',
      'TTS first audio byte stage latency',
      summary.latencies.tts_first_audio
    );

    return lines.join('\n') + '\n';
  }

  public reset(): void {
    this.startTime = Date.now();
    this.callsTotal = 0;
    this.callsCompleted = 0;
    this.callsDropped = 0;
    this.callsEmergency = 0;
    this.callsError = 0;
    this.activeCalls = 0;
    this.bookingsSucceeded = 0;
    this.bookingsFailed = 0;
    this.reschedulesSucceeded = 0;
    this.reschedulesFailed = 0;
    this.cancellationsSucceeded = 0;
    this.cancellationsFailed = 0;
    this.emergenciesTotal = 0;
    this.failuresByType.clear();
    this.sttSamples = [];
    this.llmFirstTokenSamples = [];
    this.llmTotalSamples = [];
    this.ttsFirstAudioSamples = [];
    this.turnTotalSamples = [];
    this.callCredits = [];
    this.totalCreditsBurned = 0;
    this.totalRequests = 0;
    this.failedRequests = 0;
  }
}

export const globalMetrics = new MetricsCollector();
