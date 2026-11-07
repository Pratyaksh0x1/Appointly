/**
 * Appointly Pre-Generated Audio Cache
 * Pre-synthesizes and caches TTS audio for fixed Hinglish phrases on server startup.
 * Delivers instant (0 ms TTS latency) audio for greetings, fillers, and emergencies.
 */

import { getProviders } from '../adapters/index.js';
import { rootLogger } from '../logger/logger.js';
import { EMERGENCY_ESCALATION_HINGLISH } from '../safety/emergency.js';

export const FIXED_PHRASES = {
  GREETING:
    'Namaste! Arogya Clinic mein aapka swagat hai. Main aapki appointment book karne mein kaise madad kar sakti hoon?',
  FILLER: 'Ji, main check kar rahi hoon, ek second...',
  EMERGENCY: EMERGENCY_ESCALATION_HINGLISH,
  FALLBACK:
    'Humein khed hai ki system mein takneeki dikkat aayi hai. Humne aapka callback request note kar liya hai. Hamari reception team jald hi aapko call karegi.',
  FAREWELL: 'Arogya Clinic call karne ke liye dhanyawad, namaste!',
  HOLD_ASK_NAME: 'Maine aapka slot hold kar liya hai. Kripya apna poora naam batayein.',
} as const;

export type FixedPhraseKey = keyof typeof FIXED_PHRASES;

interface CachedAudioItem {
  key: string;
  text: string;
  audioBuffer: Buffer;
  mimeType: string;
  sampleRate: number;
  durationMs: number;
}

const audioCache = new Map<string, CachedAudioItem>();
let isInitialized = false;

/**
 * Initializes the pre-generated audio cache for all fixed phrases.
 */
export async function initAudioCache(): Promise<void> {
  if (isInitialized) return;

  rootLogger.info('[AudioCache] Pre-generating audio cache for fixed voice phrases...');
  const tts = getProviders().tts;

  for (const [key, text] of Object.entries(FIXED_PHRASES)) {
    try {
      const res = await tts.synthesize(text, { callId: 'cache_warmup' });
      audioCache.set(key, {
        key,
        text,
        audioBuffer: res.audioBuffer,
        mimeType: res.mimeType,
        sampleRate: res.sampleRate,
        durationMs: res.durationMs,
      });
      // Also cache by normalized text
      audioCache.set(normalizePhrase(text), {
        key,
        text,
        audioBuffer: res.audioBuffer,
        mimeType: res.mimeType,
        sampleRate: res.sampleRate,
        durationMs: res.durationMs,
      });
    } catch (err) {
      rootLogger.warn(`[AudioCache] Could not pre-generate audio for "${key}":`, err);
    }
  }

  isInitialized = true;
  rootLogger.info(
    `[AudioCache] Pre-generated audio cache ready with ${audioCache.size} phrase variations.`
  );
}

/**
 * Retrieves cached audio by key or matching text.
 */
export function getCachedAudio(keyOrText: string): CachedAudioItem | null {
  // Check exact key (e.g. 'GREETING', 'FILLER')
  const byKey = audioCache.get(keyOrText);
  if (byKey) return byKey;

  // Check normalized text
  const byText = audioCache.get(normalizePhrase(keyOrText));
  if (byText) return byText;

  return null;
}

/**
 * Checks if a given text has pre-generated cached audio.
 */
export function hasCachedAudio(text: string): boolean {
  return getCachedAudio(text) !== null;
}

function normalizePhrase(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]/g, '');
}
