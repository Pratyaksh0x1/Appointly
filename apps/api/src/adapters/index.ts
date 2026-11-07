/**
 * Appointly AI Adapter Registry & Provider Factory
 * Encapsulates dependency injection for STT, TTS, and LLM providers.
 * Seamlessly selects Mock Providers in dev/test and Real Gnani/Evon Providers in production.
 */

import { SttProvider, TtsProvider, LlmProvider } from './types.js';
import { MockSttAdapter, MockTtsAdapter, MockLlmAdapter } from './mock-adapters.js';
import { GnaniSttAdapter, GnaniTtsAdapter, EvonOpenAiLlmAdapter } from './gnani-adapters.js';
import { getEnv } from '../config/env.js';
import { rootLogger } from '../logger/logger.js';

export interface ProviderSuite {
  stt: SttProvider;
  tts: TtsProvider;
  llm: LlmProvider;
}

let activeSuite: ProviderSuite | null = null;

export function getProviders(): ProviderSuite {
  if (activeSuite) {
    return activeSuite;
  }

  const env = getEnv();

  if (env.USE_MOCK_SERVICES) {
    rootLogger.info('Initializing Appointly In-Memory Mock AI Adapters (0 external credits)');
    activeSuite = {
      stt: new MockSttAdapter(),
      tts: new MockTtsAdapter(),
      llm: new MockLlmAdapter(),
    };
  } else {
    rootLogger.info('Initializing Production Gnani & Evon AI Adapters', {
      sttEndpoint: env.GNANI_STT_URL,
      ttsEndpoint: env.GNANI_TTS_URL,
      llmBaseUrl: env.EVON_BASE_URL,
      llmModel: env.EVON_MODEL,
    });
    activeSuite = {
      stt: new GnaniSttAdapter(env.GNANI_API_KEY, env.GNANI_STT_URL),
      tts: new GnaniTtsAdapter(env.GNANI_API_KEY, env.GNANI_TTS_URL),
      llm: new EvonOpenAiLlmAdapter(env.EVON_API_KEY, env.EVON_BASE_URL, env.EVON_MODEL),
    };
  }

  return activeSuite;
}

/**
 * Resets the active suite (used for tests or dynamic reconfiguration)
 */
export function setProvidersForTesting(suite: ProviderSuite | null): void {
  activeSuite = suite;
}

export * from './types.js';
export * from './errors.js';
export * from './mock-adapters.js';
export * from './gnani-adapters.js';
