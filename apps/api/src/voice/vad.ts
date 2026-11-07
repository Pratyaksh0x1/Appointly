/**
 * Voice Activity Detector (VAD) & End-of-Speech Endpointing
 * Computes RMS audio energy on streaming PCM audio chunks to detect speech onset
 * and end-of-speech silence windows (endpointing).
 */

export interface VadConfig {
  sampleRate: number; // default 16000
  bytesPerSample: number; // default 2 (16-bit PCM)
  energyThreshold: number; // RMS threshold to trigger speech (default 400 in 16-bit scale)
  silenceDurationMs: number; // Silence duration to trigger speech end (default 700ms)
  minSpeechDurationMs: number; // Minimum speech before silence triggers end (default 250ms)
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  sampleRate: 16000,
  bytesPerSample: 2,
  energyThreshold: 450,
  silenceDurationMs: 700,
  minSpeechDurationMs: 250,
};

export type VadState = 'SILENCE' | 'SPEECH' | 'PAUSING';

export interface VadFrameResult {
  isSpeaking: boolean;
  rmsEnergy: number;
  speechDurationMs: number;
  silenceDurationMs: number;
  isSpeechEnd: boolean;
  isSpeechStart: boolean;
}

export class VoiceActivityDetector {
  private config: VadConfig;
  private state: VadState = 'SILENCE';
  private speechDurationMs: number = 0;
  private silenceDurationMs: number = 0;
  private totalAudioMs: number = 0;

  constructor(config: Partial<VadConfig> = {}) {
    this.config = { ...DEFAULT_VAD_CONFIG, ...config };
  }

  /**
   * Resets VAD state for a new turn or after barge-in.
   */
  public reset(): void {
    this.state = 'SILENCE';
    this.speechDurationMs = 0;
    this.silenceDurationMs = 0;
    this.totalAudioMs = 0;
  }

  /**
   * Processes a raw audio buffer (16-bit PCM mono).
   */
  public processChunk(chunk: Buffer | Uint8Array): VadFrameResult {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const numSamples = buffer.length / this.config.bytesPerSample;
    const chunkDurationMs = (numSamples / this.config.sampleRate) * 1000;
    this.totalAudioMs += chunkDurationMs;

    // Compute RMS Energy
    let sumSquares = 0;
    for (let i = 0; i < buffer.length - 1; i += 2) {
      const sample = buffer.readInt16LE(i);
      sumSquares += sample * sample;
    }
    const rms = numSamples > 0 ? Math.sqrt(sumSquares / numSamples) : 0;

    let isSpeechStart = false;
    let isSpeechEnd = false;

    const isAboveThreshold = rms >= this.config.energyThreshold;

    if (this.state === 'SILENCE') {
      if (isAboveThreshold) {
        this.state = 'SPEECH';
        this.speechDurationMs = chunkDurationMs;
        this.silenceDurationMs = 0;
        isSpeechStart = true;
      }
    } else if (this.state === 'SPEECH') {
      if (isAboveThreshold) {
        this.speechDurationMs += chunkDurationMs;
        this.silenceDurationMs = 0;
      } else {
        this.state = 'PAUSING';
        this.silenceDurationMs = chunkDurationMs;
      }
    } else if (this.state === 'PAUSING') {
      if (isAboveThreshold) {
        // Resumed speaking
        this.state = 'SPEECH';
        this.speechDurationMs += this.silenceDurationMs + chunkDurationMs;
        this.silenceDurationMs = 0;
      } else {
        this.silenceDurationMs += chunkDurationMs;
        // Check if silence exceeded threshold after minimum speech
        if (
          this.silenceDurationMs >= this.config.silenceDurationMs &&
          this.speechDurationMs >= this.config.minSpeechDurationMs
        ) {
          isSpeechEnd = true;
          this.state = 'SILENCE';
        }
      }
    }

    return {
      isSpeaking: this.state === 'SPEECH' || this.state === 'PAUSING',
      rmsEnergy: Math.round(rms),
      speechDurationMs: Math.round(this.speechDurationMs),
      silenceDurationMs: Math.round(this.silenceDurationMs),
      isSpeechEnd,
      isSpeechStart,
    };
  }

  public getState(): VadState {
    return this.state;
  }
}
