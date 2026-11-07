/**
 * Gnani Prisma Speech-to-Text (STT) Client
 * Documented at: https://docs.gnani.ai/api/STT/overview.md
 * Integrates with Cost Meter, bounded retries, and graceful fallbacks.
 */

import { getEnv } from '../config/env.js';
import { globalCostMeter } from '../cost/cost-meter.js';
import { withRetryAndFallback, ExternalServiceError } from '../utils/retry.js';
import { rootLogger } from '../logger/logger.js';

export interface STTTranscriptionResult {
  success: boolean;
  transcript: string;
  detectedLanguageCode?: string;
  processingTimeSeconds?: number;
  isMock?: boolean;
}

export interface ISTTClient {
  transcribeAudio(
    audioBuffer: Buffer,
    callId: string,
    options?: {
      patientPhone?: string;
      languageCode?: string;
      model?: string;
      durationSeconds?: number;
    }
  ): Promise<STTTranscriptionResult>;
}

export class GnaniSTTClient implements ISTTClient {
  private apiKey: string;
  private restUrl: string;
  private defaultModel: string;
  private defaultLanguage: string;
  private isMockMode: boolean;

  constructor(options?: {
    apiKey?: string;
    restUrl?: string;
    defaultModel?: string;
    defaultLanguage?: string;
    isMockMode?: boolean;
  }) {
    const env = getEnv();
    this.apiKey = options?.apiKey || env.GNANI_API_KEY;
    this.restUrl = options?.restUrl || env.GNANI_STT_URL;
    this.defaultModel = options?.defaultModel || env.GNANI_STT_MODEL;
    this.defaultLanguage = options?.defaultLanguage || env.GNANI_STT_LANGUAGE;
    this.isMockMode = options?.isMockMode ?? env.USE_MOCK_SERVICES;
  }

  public async transcribeAudio(
    audioBuffer: Buffer,
    callId: string,
    options?: {
      patientPhone?: string;
      languageCode?: string;
      model?: string;
      durationSeconds?: number;
    }
  ): Promise<STTTranscriptionResult> {
    const durationSeconds = options?.durationSeconds ?? Math.max(1, Math.round(audioBuffer.length / 32000));
    const languageCode = options?.languageCode || this.defaultLanguage;
    const model = options?.model || this.defaultModel;

    // 1. Cost Pre-flight Check
    const estimatedCredits = globalCostMeter.estimateCredits('PRISMA_STT', durationSeconds);
    globalCostMeter.checkCanSpend(callId, estimatedCredits);

    // 2. Mock mode execution (Zero credit burn for unit tests & local dev)
    if (this.isMockMode) {
      globalCostMeter.recordSpend(callId, 'PRISMA_STT', durationSeconds, true);
      rootLogger.info('Gnani STT [Mock Mode] returning simulated transcript', { callId, durationSeconds });

      return {
        success: true,
        transcript: 'Namaste, mujhe Dr. Sharma se appointment book karna hai',
        detectedLanguageCode: 'hi-IN',
        processingTimeSeconds: 0.05,
        isMock: true,
      };
    }

    // 3. Real Gnani Prisma v3.0 REST API Request
    return await withRetryAndFallback<STTTranscriptionResult>(
      async (signal) => {
        const formData = new FormData();
        const blob = new Blob([audioBuffer], { type: 'audio/wav' });
        formData.append('audio_file', blob, 'patient_speech.wav');
        formData.append('model', model);
        formData.append('language_code', languageCode);
        formData.append('format', 'transcribe');

        const response = await fetch(this.restUrl, {
          method: 'POST',
          headers: {
            'X-API-Key-ID': this.apiKey,
          },
          body: formData,
          signal,
        });

        if (!response.ok) {
          const errorBody = await response.text();
          throw new ExternalServiceError(
            `Gnani STT API error (${response.status}): ${errorBody}`,
            response.status,
            response.status >= 500 || response.status === 429
          );
        }

        const data = (await response.json()) as {
          success?: boolean;
          transcript?: string;
          detected_language_code?: string;
          processing_time?: number;
        };

        // Record verified spend
        globalCostMeter.recordSpend(callId, 'PRISMA_STT', durationSeconds, false);

        return {
          success: data.success ?? true,
          transcript: data.transcript || '',
          detectedLanguageCode: data.detected_language_code || 'hi-IN',
          processingTimeSeconds: data.processing_time || 0.5,
          isMock: false,
        };
      },
      {
        callId,
        patientPhone: options?.patientPhone,
        operationName: 'Gnani_STT_Prisma',
        fallbackValue: {
          success: false,
          transcript: '',
          detectedLanguageCode: 'unknown',
          isMock: false,
        },
      }
    );
  }
}

