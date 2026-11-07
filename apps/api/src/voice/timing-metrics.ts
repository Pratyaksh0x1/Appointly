/**
 * Per-Turn Latency Tracking & Telemetry Engine
 * Measures critical telephony voice pipeline milestones:
 * - stt_ms: End-of-speech to final transcript
 * - llm_first_token_ms: Final transcript to first LLM token / state machine tool trigger
 * - tts_first_audio_ms: First text chunk to first audio byte emitted
 * - total_ms: End-of-speech to first audio playback byte
 * Computes P50 and P95 percentiles against the 1.5s voice response target.
 */

import { rootLogger } from '../logger/logger.js';

export interface TurnLatencyMetrics {
  callId: string;
  turnIndex: number;
  stt_ms: number;
  llm_first_token_ms: number;
  tts_first_audio_ms: number;
  total_ms: number;
  isCachedPhrase: boolean;
  timestamp: number;
}

export interface LatencyPercentiles {
  count: number;
  p50_total_ms: number;
  p95_total_ms: number;
  p50_stt_ms: number;
  p50_llm_ms: number;
  p50_tts_ms: number;
  target_met_rate: number; // % of turns <= 1500ms
}

export class TurnMetricsTracker {
  private callId: string;
  private turnIndex: number = 0;
  private speechEndTs: number = 0;
  private sttDoneTs: number = 0;
  private llmFirstTokenTs: number = 0;
  private ttsFirstAudioTs: number = 0;
  private isCached: boolean = false;

  constructor(callId: string) {
    this.callId = callId;
  }

  public startTurn(turnIndex: number, speechEndTs: number = Date.now()): void {
    this.turnIndex = turnIndex;
    this.speechEndTs = speechEndTs;
    this.sttDoneTs = 0;
    this.llmFirstTokenTs = 0;
    this.ttsFirstAudioTs = 0;
    this.isCached = false;
  }

  public markSttDone(timestamp: number = Date.now()): void {
    this.sttDoneTs = timestamp;
  }

  public markLlmFirstToken(timestamp: number = Date.now()): void {
    if (!this.llmFirstTokenTs) {
      this.llmFirstTokenTs = timestamp;
    }
  }

  public markTtsFirstAudio(isCached: boolean = false, timestamp: number = Date.now()): void {
    if (!this.ttsFirstAudioTs) {
      this.ttsFirstAudioTs = timestamp;
      this.isCached = isCached;
    }
  }

  public finalizeMetrics(): TurnLatencyMetrics {
    const now = Date.now();
    const sttDone = this.sttDoneTs || now;
    const llmFirst = this.llmFirstTokenTs || sttDone;
    const ttsFirst = this.ttsFirstAudioTs || now;

    const stt_ms = Math.max(0, sttDone - this.speechEndTs);
    const llm_first_token_ms = Math.max(0, llmFirst - sttDone);
    const tts_first_audio_ms = Math.max(0, ttsFirst - llmFirst);
    const total_ms = Math.max(0, ttsFirst - this.speechEndTs);

    const metrics: TurnLatencyMetrics = {
      callId: this.callId,
      turnIndex: this.turnIndex,
      stt_ms,
      llm_first_token_ms,
      tts_first_audio_ms,
      total_ms,
      isCachedPhrase: this.isCached,
      timestamp: now,
    };

    globalLatencyCollector.recordTurn(metrics);

    rootLogger.info(`[VoiceLatency] Turn ${this.turnIndex} latency recorded`, {
      callId: this.callId,
      turnIndex: this.turnIndex,
      stt_ms,
      llm_first_token_ms,
      tts_first_audio_ms,
      total_ms,
      isCachedPhrase: this.isCached,
      targetMet: total_ms <= 1500,
    });

    return metrics;
  }
}

/**
 * Global Latency Collector for System-Wide P50 / P95 Telemetry
 */
export class GlobalLatencyCollector {
  private history: TurnLatencyMetrics[] = [];
  private maxHistory: number = 1000;

  public recordTurn(metric: TurnLatencyMetrics): void {
    this.history.push(metric);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  public getSummary(): LatencyPercentiles {
    if (this.history.length === 0) {
      return {
        count: 0,
        p50_total_ms: 0,
        p95_total_ms: 0,
        p50_stt_ms: 0,
        p50_llm_ms: 0,
        p50_tts_ms: 0,
        target_met_rate: 100,
      };
    }

    const totals = this.history.map((h) => h.total_ms).sort((a, b) => a - b);
    const stts = this.history.map((h) => h.stt_ms).sort((a, b) => a - b);
    const llms = this.history.map((h) => h.llm_first_token_ms).sort((a, b) => a - b);
    const ttss = this.history.map((h) => h.tts_first_audio_ms).sort((a, b) => a - b);

    const p50Idx = Math.floor(totals.length * 0.5);
    const p95Idx = Math.floor(totals.length * 0.95);

    const underTargetCount = totals.filter((t) => t <= 1500).length;
    const targetMetRate = Math.round((underTargetCount / totals.length) * 100);

    return {
      count: this.history.length,
      p50_total_ms: totals[p50Idx] || 0,
      p95_total_ms: totals[p95Idx] || totals[totals.length - 1] || 0,
      p50_stt_ms: stts[p50Idx] || 0,
      p50_llm_ms: llms[p50Idx] || 0,
      p50_tts_ms: ttss[p50Idx] || 0,
      target_met_rate: targetMetRate,
    };
  }

  public getStats(): LatencyPercentiles {
    return this.getSummary();
  }

  public reset(): void {
    this.history = [];
  }
}

export const globalLatencyCollector = new GlobalLatencyCollector();
