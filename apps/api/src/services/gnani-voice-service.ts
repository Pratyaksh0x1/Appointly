/**
 * Gnani.ai Voice Services (Prisma STT & Timbre TTS)
 * Strictly utilizes official Gnani.ai Vachana endpoints with GNANI_API_KEY.
 */

import { getEnv } from '../config/env.js';
import { rootLogger } from '../logger/logger.js';
import { globalCostMeter } from '../cost/cost-meter.js';

export interface GnaniSttResponse {
  success: boolean;
  transcript: string;
  confidence?: number;
  processingTime?: number;
  error?: string;
}

export interface GnaniTtsResponse {
  success: boolean;
  audioBuffer: Buffer;
  audioBase64: string;
  contentType: string;
  durationEstimateMs: number;
  error?: string;
}

/**
 * Transcribes audio buffer using Gnani Prisma STT v3.0
 */
export async function transcribeAudioWithGnani(
  audioBuffer: Buffer,
  callId: string = `stt_${Date.now()}`,
  options?: { languageCode?: string; model?: string }
): Promise<GnaniSttResponse> {
  const env = getEnv();
  const apiKey = env.GNANI_API_KEY;
  const endpoint = env.GNANI_STT_URL || 'https://api.vachana.ai/stt/v3';

  if (!apiKey) {
    throw new Error('GNANI_API_KEY is not configured in environment.');
  }

  const durationSec = Math.max(1, Math.round(audioBuffer.length / 32000));
  globalCostMeter.recordSpend(callId, 'PRISMA_STT', durationSec, false);

  const formData = new FormData();
  formData.append('audio_file', new Blob([audioBuffer], { type: 'audio/wav' }), 'audio.wav');
  formData.append('model', options?.model || env.GNANI_STT_MODEL || 'prisma-v3.0');
  formData.append('language_code', options?.languageCode || env.GNANI_STT_LANGUAGE || 'indic-auto');
  formData.append('format', 'codemix');

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-API-Key-ID': apiKey,
      },
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      rootLogger.error(`[Gnani STT] Error response (${res.status}): ${errText}`, { callId });
      return {
        success: false,
        transcript: '',
        error: `Gnani STT HTTP ${res.status}: ${errText}`,
      };
    }

    const data = (await res.json()) as any;
    const transcript =
      (data.transcript as string) ||
      (data.text as string) ||
      (data.result as string) ||
      '';

    rootLogger.info(`[Gnani STT] Transcribed: "${transcript}"`, {
      callId,
      confidence: data.confidence,
    });

    return {
      success: true,
      transcript: transcript.trim(),
      confidence: data.confidence || 0.95,
      processingTime: data.processing_time,
    };
  } catch (err: any) {
    rootLogger.error(`[Gnani STT] Request failed: ${err.message}`, { callId });
    return {
      success: false,
      transcript: '',
      error: err.message,
    };
  }
}

/**
 * Synthesizes text to speech using Gnani Timbre TTS
 */
export async function synthesizeSpeechWithGnani(
  text: string,
  callId: string = `tts_${Date.now()}`,
  options?: { voice?: string; language?: string; speed?: number }
): Promise<GnaniTtsResponse> {
  const env = getEnv();
  const apiKey = env.GNANI_API_KEY;
  const endpoint = env.GNANI_TTS_URL || 'https://api.vachana.ai/api/v1/tts/inference';

  if (!apiKey) {
    throw new Error('GNANI_API_KEY is not configured in environment.');
  }

  // Clean markdown asterisks and special tags for cleaner audio synthesis
  const cleanText = text
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#_~`]/g, '')
    .trim();

  const characterCount = cleanText.length;
  globalCostMeter.recordSpend(callId, 'TIMBRE_TTS', characterCount, false);

  const payload = {
    text: cleanText,
    model: env.GNANI_TTS_MODEL || 'timbre-v3.0',
    voice: options?.voice || env.GNANI_TTS_VOICE || 'Shivani',
    language: options?.language || env.GNANI_TTS_LANGUAGE || 'hi-IN',
    speed: options?.speed ?? env.GNANI_TTS_SPEED ?? 1.0,
    audio_config: {
      container: 'wav',
      encoding: 'linear_pcm',
      sample_rate: 16000,
    },
  };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-API-Key-ID': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      rootLogger.error(`[Gnani TTS] Error response (${res.status}): ${errText}`, { callId });
      return {
        success: false,
        audioBuffer: Buffer.alloc(0),
        audioBase64: '',
        contentType: 'audio/wav',
        durationEstimateMs: 0,
        error: `Gnani TTS HTTP ${res.status}: ${errText}`,
      };
    }

    const arrayBuffer = await res.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    // CRITICAL BROWSER AUDIO COMPATIBILITY FIX:
    // Gnani Timbre TTS sets 0xFFFFFFFF (4294967295) for streaming chunk sizes.
    // Standard web browsers (Chrome, Safari, Edge) reject this as invalid WAV and refuse to play.
    // Patch RIFF total size and Subchunk2 (data) size with actual byte lengths:
    if (audioBuffer.length >= 44 && audioBuffer.slice(0, 4).toString('ascii') === 'RIFF') {
      audioBuffer.writeUInt32LE(audioBuffer.length - 8, 4);
      audioBuffer.writeUInt32LE(audioBuffer.length - 44, 40);
    }

    const audioBase64 = `data:audio/wav;base64,${audioBuffer.toString('base64')}`;
    const durationEstimateMs = Math.round((audioBuffer.length / (16000 * 2)) * 1000);

    rootLogger.info(`[Gnani TTS] Synthesized ${audioBuffer.length} bytes for ${characterCount} chars`, {
      callId,
      durationEstimateMs,
    });

    return {
      success: true,
      audioBuffer,
      audioBase64,
      contentType: 'audio/wav',
      durationEstimateMs,
    };
  } catch (err: any) {
    rootLogger.error(`[Gnani TTS] Request failed: ${err.message}`, { callId });
    return {
      success: false,
      audioBuffer: Buffer.alloc(0),
      audioBase64: '',
      contentType: 'audio/wav',
      durationEstimateMs: 0,
      error: err.message,
    };
  }
}

