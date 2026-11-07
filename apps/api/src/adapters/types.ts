/**
 * Provider-Agnostic Voice & AI Model Interfaces
 * Supports Gnani Prisma (STT), Gnani Timbre (TTS), and Evon 30B (LLM)
 * plus full in-memory MOCK providers for testing and dev environments.
 */

// ==========================================
// 1. SPEECH-TO-TEXT (STT)
// ==========================================

export interface SttOptions {
  model?: string;
  languageCode?: string;
  format?: 'code-mix' | 'transcribe' | 'verbatim' | 'transliterate';
  callId?: string;
  timeoutMs?: number;
  sampleRate?: number;
}

export interface SttResult {
  transcript: string;
  confidence: number;
  language: string;
  durationSeconds: number;
  isFinal: boolean;
  rawResponse?: unknown;
}

export interface SttStreamSession {
  sendAudioChunk(chunk: Buffer | Uint8Array): void;
  endAudio(): void;
  onTranscript(callback: (result: SttResult) => void): void;
  onError(callback: (err: Error) => void): void;
  close(): void;
}

export interface SttProvider {
  readonly name: string;
  transcribe(audio: Buffer | Uint8Array, options?: SttOptions): Promise<SttResult>;
  createStream?(options?: SttOptions): SttStreamSession;
}

// ==========================================
// 2. TEXT-TO-SPEECH (TTS)
// ==========================================

export interface TtsOptions {
  model?: string;
  voice?: string;
  language?: string;
  speed?: number;
  callId?: string;
  container?: 'wav' | 'raw' | 'mp3' | 'mulaw';
  sampleRate?: number;
  timeoutMs?: number;
}

export interface TtsResult {
  audioBuffer: Buffer;
  mimeType: string;
  sampleRate: number;
  characterCount: number;
  durationMs: number;
}

export interface TtsProvider {
  readonly name: string;
  synthesize(text: string, options?: TtsOptions): Promise<TtsResult>;
  createStream?(text: string, options?: TtsOptions): AsyncIterable<Uint8Array>;
}

// ==========================================
// 3. LARGE LANGUAGE MODEL (LLM)
// ==========================================

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: LlmToolCall[];
}

export interface LlmToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: Record<string, unknown>;
}

export interface LlmToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, LlmToolParameterProperty>;
      required?: string[];
    };
  };
}

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface LlmChatOptions {
  callId?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: LlmToolDefinition[];
  timeoutMs?: number;
  idempotent?: boolean; // When true, retry with backoff is allowed
}

export interface LlmResponse {
  content: string;
  toolCalls?: LlmToolCall[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
}

export interface LlmStreamChunk {
  contentChunk?: string;
  toolCallChunk?: Partial<LlmToolCall>;
  isFinal: boolean;
}

export interface LlmProvider {
  readonly name: string;
  chat(messages: LlmMessage[], options?: LlmChatOptions): Promise<LlmResponse>;
  streamChat?(messages: LlmMessage[], options?: LlmChatOptions): AsyncIterable<LlmStreamChunk>;
}
