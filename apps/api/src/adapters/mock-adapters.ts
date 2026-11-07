/**
 * In-Memory Mock Adapters for Gnani STT, Timbre TTS, and Evon LLM
 * Used by default in development and automated testing environments.
 * Burns ZERO external credits and simulates realistic streaming & tool-calling behavior.
 */

import {
  SttProvider,
  SttOptions,
  SttResult,
  SttStreamSession,
  TtsProvider,
  TtsOptions,
  TtsResult,
  LlmProvider,
  LlmMessage,
  LlmChatOptions,
  LlmResponse,
  LlmStreamChunk,
} from './types.js';
import { globalCostMeter } from '../cost/cost-meter.js';
import { rootLogger } from '../logger/logger.js';

// ==========================================
// 1. MOCK STT ADAPTER (Prisma v3.0 Mock)
// ==========================================

export class MockSttAdapter implements SttProvider {
  public readonly name = 'MockPrismaSTT';
  private simulatedTranscript: string;

  constructor(
    defaultTranscript: string = 'Mujhe kal subah Dr. Sharma ke paas appointment chahiye fever ke liye.'
  ) {
    this.simulatedTranscript = defaultTranscript;
  }

  public setSimulatedTranscript(transcript: string): void {
    this.simulatedTranscript = transcript;
  }

  public async transcribe(audio: Buffer | Uint8Array, options?: SttOptions): Promise<SttResult> {
    const callId = options?.callId || 'mock_stt_call';
    const estimatedDurationSec = Math.max(1, Math.round(audio.length / 32000));

    // Guard against silence, empty audio buffers, or noise-spikes triggering automated loops
    if (audio.length < 3200) {
      return {
        transcript: '',
        confidence: 0,
        language: options?.languageCode || 'hi-IN',
        durationSeconds: 0,
        isFinal: true,
        rawResponse: { mock: true, empty: true },
      };
    }

    // Pre-flight check & audit record (0 credits in mock mode)
    globalCostMeter.checkCanSpend(callId, 0);
    globalCostMeter.recordSpend(callId, 'PRISMA_STT', estimatedDurationSec, true);

    rootLogger.info(`[${this.name}] Simulated transcription complete`, {
      callId,
      durationSec: estimatedDurationSec,
    });

    return {
      transcript: this.simulatedTranscript,
      confidence: 0.98,
      language: options?.languageCode || 'hi-IN',
      durationSeconds: estimatedDurationSec,
      isFinal: true,
      rawResponse: { mock: true },
    };
  }

  public createStream(options?: SttOptions): SttStreamSession {
    let transcriptCallback: ((result: SttResult) => void) | null = null;
    let errorCallback: ((err: Error) => void) | null = null;
    let isClosed = false;

    return {
      sendAudioChunk: (_chunk: Buffer | Uint8Array) => {
        if (isClosed) return;
        // Emit intermediate partial result
        if (transcriptCallback) {
          transcriptCallback({
            transcript: this.simulatedTranscript.slice(0, 15) + '...',
            confidence: 0.85,
            language: options?.languageCode || 'hi-IN',
            durationSeconds: 1,
            isFinal: false,
          });
        }
      },
      endAudio: () => {
        if (isClosed) return;
        if (transcriptCallback) {
          transcriptCallback({
            transcript: this.simulatedTranscript,
            confidence: 0.98,
            language: options?.languageCode || 'hi-IN',
            durationSeconds: 3,
            isFinal: true,
          });
        }
      },
      onTranscript: (cb) => {
        transcriptCallback = cb;
      },
      onError: (cb) => {
        errorCallback = cb;
      },
      close: () => {
        isClosed = true;
      },
    };
  }
}

// ==========================================
// 2. MOCK TTS ADAPTER (Timbre v3.0 Mock)
// ==========================================

export class MockTtsAdapter implements TtsProvider {
  public readonly name = 'MockTimbreTTS';

  public async synthesize(text: string, options?: TtsOptions): Promise<TtsResult> {
    const callId = options?.callId || 'mock_tts_call';
    const charCount = text.length;

    // Record mock spend (0 credits)
    globalCostMeter.checkCanSpend(callId, 0);
    globalCostMeter.recordSpend(callId, 'TIMBRE_TTS', charCount, true);

    // Generate valid 16kHz mono 16-bit PCM WAV container
    const sampleRate = options?.sampleRate || 16000;
    const numSamples = Math.max(sampleRate / 2, charCount * 300); // ~50ms per character
    const audioBuffer = createSyntheticWavBuffer(sampleRate, numSamples);

    rootLogger.info(`[${this.name}] Simulated speech synthesis complete`, {
      callId,
      charCount,
      byteLength: audioBuffer.length,
    });

    return {
      audioBuffer,
      mimeType: 'audio/wav',
      sampleRate,
      characterCount: charCount,
      durationMs: Math.round((numSamples / sampleRate) * 1000),
    };
  }

  public async *createStream(text: string, options?: TtsOptions): AsyncIterable<Uint8Array> {
    const fullResult = await this.synthesize(text, options);
    const chunkSize = 4096;
    for (let i = 0; i < fullResult.audioBuffer.length; i += chunkSize) {
      yield fullResult.audioBuffer.subarray(i, i + chunkSize);
    }
  }
}

// ==========================================
// 3. MOCK LLM ADAPTER (Evon 30B Mock)
// ==========================================

export class MockLlmAdapter implements LlmProvider {
  public readonly name = 'MockEvonLLM';
  private forcedResponse?: LlmResponse;

  public setForcedResponse(res: LlmResponse): void {
    this.forcedResponse = res;
  }

  public async chat(messages: LlmMessage[], options?: LlmChatOptions): Promise<LlmResponse> {
    const callId = options?.callId || 'mock_llm_call';

    if (this.forcedResponse) {
      return this.forcedResponse;
    }

    const lastUserMessage =
      [...messages]
        .reverse()
        .find((m) => m.role === 'user')
        ?.content.toLowerCase() || '';

    // Record spend (0 credits in mock mode)
    globalCostMeter.checkCanSpend(callId, 0);
    globalCostMeter.recordSpend(callId, 'EVON_LLM', 150, true);

    // Dynamic mock reasoning based on user input
    if (
      lastUserMessage.includes('appointment') ||
      lastUserMessage.includes('doctor') ||
      lastUserMessage.includes('sharma') ||
      lastUserMessage.includes('fever')
    ) {
      // Evon calls validated tool: check_slots
      return {
        content: 'Main Dr. Sharma ke available slots check kar rahi hoon...',
        toolCalls: [
          {
            id: `call_${Date.now()}`,
            type: 'function',
            function: {
              name: 'check_slots',
              arguments: JSON.stringify({
                doctorId: 'dr_sharma',
                date: '2026-11-10',
                appointmentTypeId: 'general_consultation',
              }),
            },
          },
        ],
        promptTokens: 85,
        completionTokens: 42,
        totalTokens: 127,
        model: 'evon-30b-mock',
      };
    }

    // Default conversational Hinglish reply
    return {
      content:
        'Namaste! Main Arogya Care Clinic se bol rahi hoon. Aapko kis doctor ke paas appointment book karna hai?',
      promptTokens: 60,
      completionTokens: 25,
      totalTokens: 85,
      model: 'evon-30b-mock',
    };
  }

  public async *streamChat(
    messages: LlmMessage[],
    options?: LlmChatOptions
  ): AsyncIterable<LlmStreamChunk> {
    const response = await this.chat(messages, options);

    if (response.toolCalls && response.toolCalls.length > 0) {
      yield {
        toolCallChunk: response.toolCalls[0],
        isFinal: true,
      };
      return;
    }

    const words = response.content.split(' ');
    for (let i = 0; i < words.length; i++) {
      yield {
        contentChunk: words[i] + (i < words.length - 1 ? ' ' : ''),
        isFinal: i === words.length - 1,
      };
    }
  }
}

/**
 * Creates a valid PCM 16-bit WAV file header and sample data
 */
function createSyntheticWavBuffer(sampleRate: number, numSamples: number): Buffer {
  const bytesPerSample = 2; // 16-bit
  const dataSize = numSamples * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF Chunk
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt Subchunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
  buffer.writeUInt16LE(1, 22); // NumChannels (1 = Mono)
  buffer.writeUInt32LE(sampleRate, 24); // SampleRate
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28); // ByteRate
  buffer.writeUInt16LE(bytesPerSample, 32); // BlockAlign
  buffer.writeUInt16LE(16, 34); // BitsPerSample

  // data Subchunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Fill sine-like tone for test playback
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 4000;
    buffer.writeInt16LE(Math.round(sample), 44 + i * 2);
  }

  return buffer;
}
