/**
 * Gnani Timbre Text-to-Speech (TTS) Client
 * Documented at: https://docs.gnani.ai/api/TTS/tts-inference.md
 * Integrates with Cost Meter, bounded retries, and audio tag handling (<pauses>).
 */

import { getEnv } from '../config/env.js';
import { globalCostMeter } from '../cost/cost-meter.js';
import { withRetryAndFallback, ExternalServiceError } from '../utils/retry.js';
import { rootLogger } from '../logger/logger.js';

export interface TTSSynthesisResult {
  audioBuffer: Buffer;
  contentType: string;
  characterCount: number;
  isMock: boolean;
}

export interface ITTSClient {
  synthesize(
    text: string,
    callId: string,
    options?: {
      voice?: string;
      model?: string;
      language?: string;
      speed?: number;
      patientPhone?: string;
    }
  ): Promise<TTSSynthesisResult>;
}

export class GnaniTTSClient implements ITTSClient {
  private apiKey: string;
  private restUrl: string;
  private defaultModel: string;
  private defaultVoice: string;
  private defaultLanguage: string;
  private defaultSpeed: number;
  private isMockMode: boolean;

  constructor(options?: {
    apiKey?: string;
    restUrl?: string;
    defaultModel?: string;
    defaultVoice?: string;
    defaultLanguage?: string;
    defaultSpeed?: number;
    isMockMode?: boolean;
  }) {
    const env = getEnv();
    this.apiKey = options?.apiKey || env.GNANI_API_KEY;
    this.restUrl = options?.restUrl || env.GNANI_TTS_URL;
    this.defaultModel = options?.defaultModel || env.GNANI_TTS_MODEL;
    this.defaultVoice = options?.defaultVoice || env.GNANI_TTS_VOICE;
    this.defaultLanguage = options?.defaultLanguage || env.GNANI_TTS_LANGUAGE;
    this.defaultSpeed = options?.defaultSpeed ?? env.GNANI_TTS_SPEED;
    this.isMockMode = options?.isMockMode ?? env.USE_MOCK_SERVICES;
  }

  /**
   * Helper to generate a minimal valid 44-byte WAV header for mock audio buffers
   */
  private createMockWavBuffer(text: string): Buffer {
    const sampleRate = 24000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    // Generate ~100ms of silence per 10 characters
    const pcmDataLength = Math.max(2400, Math.min(24000, text.length * 240));

    const buffer = Buffer.alloc(44 + pcmDataLength);
    // RIFF chunk descriptor
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + pcmDataLength, 4);
    buffer.write('WAVE', 8);
    // fmt sub-chunk
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // Subchunk1Size
    buffer.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    // data sub-chunk
    buffer.write('data', 36);
    buffer.writeUInt32LE(pcmDataLength, 40);

    return buffer;
  }

  public async synthesize(
    text: string,
    callId: string,
    options?: {
      voice?: string;
      model?: string;
      language?: string;
      speed?: number;
      patientPhone?: string;
    }
  ): Promise<TTSSynthesisResult> {
    const characterCount = text.length;
    const voice = options?.voice || this.defaultVoice;
    const model = options?.model || this.defaultModel;
    const language = options?.language || this.defaultLanguage;
    const speed = options?.speed ?? this.defaultSpeed;

    // 1. Cost Pre-flight Check
    const estimatedCredits = globalCostMeter.estimateCredits('TIMBRE_TTS', characterCount);
    globalCostMeter.checkCanSpend(callId, estimatedCredits);

    // 2. Mock mode execution
    if (this.isMockMode) {
      globalCostMeter.recordSpend(callId, 'TIMBRE_TTS', characterCount, true);
      rootLogger.info('Gnani TTS [Mock Mode] returning synthetic audio', { callId, characterCount, voice });

      return {
        audioBuffer: this.createMockWavBuffer(text),
        contentType: 'audio/wav',
        characterCount,
        isMock: true,
      };
    }

    // 3. Real Gnani Timbre REST API Request
    return await withRetryAndFallback<TTSSynthesisResult>(
      async (signal) => {
        const payload = {
          text,
          voice,
          model,
          language,
          speed,
          audio_config: {
            sample_rate: 24000,
            num_channels: 1,
            sample_width: 2,
            encoding: 'linear_pcm',
            container: 'wav',
          },
        };

        const response = await fetch(this.restUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key-ID': this.apiKey,
          },
          body: JSON.stringify(payload),
          signal,
        });

        if (!response.ok) {
          const errorBody = await response.text();
          throw new ExternalServiceError(
            `Gnani TTS API error (${response.status}): ${errorBody}`,
            response.status,
            response.status >= 500 || response.status === 429
          );
        }

        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = Buffer.from(arrayBuffer);

        // Record verified spend
        globalCostMeter.recordSpend(callId, 'TIMBRE_TTS', characterCount, false);

        return {
          audioBuffer,
          contentType: response.headers.get('content-type') || 'audio/wav',
          characterCount,
          isMock: false,
        };
      },
      {
        callId,
        patientPhone: options?.patientPhone,
        operationName: 'Gnani_TTS_Timbre',
        fallbackValue: {
          audioBuffer: this.createMockWavBuffer('Technical issue apology audio'),
          contentType: 'audio/wav',
          characterCount,
          isMock: true,
        },
      }
    );
  }
}

