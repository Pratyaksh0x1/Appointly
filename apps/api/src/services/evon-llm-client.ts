/**
 * Evon 30B LLM Client (Gnani Foundational Indic LLM)
 * Documented at: https://docs.gnani.ai/Platform/Get_LLM_Models.md
 * TODO(verify): Verify exact Gnani Evon 30B chat completion endpoint URL, model identifier string, and auth headers.
 *
 * Non-Negotiable Rule 1: The LLM NEVER writes directly to the database.
 * It only calls validated tools. Booking is decided by a DB transaction.
 */

import { getEnv } from '../config/env.js';
import { globalCostMeter } from '../cost/cost-meter.js';
import { withRetryAndFallback, ExternalServiceError } from '../utils/retry.js';
import { rootLogger } from '../logger/logger.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface LLMResponse {
  message: ChatMessage;
  tokensUsed: number;
  isMock: boolean;
}

export interface ILLMClient {
  generateResponse(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    callId: string,
    options?: { patientPhone?: string; temperature?: number }
  ): Promise<LLMResponse>;
}

export class EvonLLMClient implements ILLMClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private isMockMode: boolean;

  constructor(options?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    isMockMode?: boolean;
  }) {
    const env = getEnv();
    this.apiKey = options?.apiKey || env.EVON_API_KEY;
    this.baseUrl = options?.baseUrl || env.EVON_BASE_URL;
    this.model = options?.model || env.EVON_MODEL;
    this.isMockMode = options?.isMockMode ?? env.USE_MOCK_SERVICES;
  }

  public async generateResponse(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    callId: string,
    options?: { patientPhone?: string; temperature?: number }
  ): Promise<LLMResponse> {
    const estimatedTokens =
      messages.reduce((acc, m) => acc + (m.content?.length || 0) / 4, 0) + 200;

    // 1. Cost Pre-flight Check
    const estimatedCredits = globalCostMeter.estimateCredits('EVON_LLM', estimatedTokens);
    globalCostMeter.checkCanSpend(callId, estimatedCredits);

    // 2. Mock mode execution for fast testing with 0 credits burned
    if (this.isMockMode) {
      return this.generateMockResponse(messages, tools, callId);
    }

    // 3. Real Evon 30B API Call (OpenAI-compatible chat completion payload)
    // TODO(verify): Validate endpoint path, e.g. /chat/completions vs /v1/chat/completions
    const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    return await withRetryAndFallback<LLMResponse>(
      async (signal) => {
        const payload: Record<string, unknown> = {
          model: this.model,
          messages,
          temperature: options?.temperature ?? 0.2,
        };

        if (tools && tools.length > 0) {
          payload.tools = tools;
          payload.tool_choice = 'auto';
        }

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            'X-API-Key-ID': this.apiKey, // Gnani platform alternate header
          },
          body: JSON.stringify(payload),
          signal,
        });

        if (!response.ok) {
          const errorBody = await response.text();
          throw new ExternalServiceError(
            `Evon 30B LLM error (${response.status}): ${errorBody}`,
            response.status,
            response.status >= 500 || response.status === 429
          );
        }

        const data = (await response.json()) as {
          choices?: Array<{ message: ChatMessage }>;
          usage?: { total_tokens?: number };
        };

        const choice = data.choices?.[0];
        if (!choice) {
          throw new ExternalServiceError('Evon 30B returned empty choices', 500, true);
        }

        const tokensUsed = data.usage?.total_tokens || Math.round(estimatedTokens);
        globalCostMeter.recordSpend(callId, 'EVON_LLM', tokensUsed, false);

        return {
          message: choice.message,
          tokensUsed,
          isMock: false,
        };
      },
      {
        callId,
        patientPhone: options?.patientPhone,
        operationName: 'Evon_30B_LLM',
        fallbackValue: {
          message: {
            role: 'assistant',
            content:
              'Maaf kijiye, hum abhi system issue face kar rahe hain. <pauses> ' +
              'Hamari team aapse thodi der me call karke appointment confirm karegi.',
          },
          tokensUsed: 0,
          isMock: true,
        },
      }
    );
  }

  /**
   * Deterministic mock generator for tests and development without hitting external APIs
   */
  private generateMockResponse(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    callId: string
  ): LLMResponse {
    const lastUserMessage =
      [...messages]
        .reverse()
        .find((m) => m.role === 'user')
        ?.content?.toLowerCase() || '';

    globalCostMeter.recordSpend(callId, 'EVON_LLM', 150, true);

    // Intent 1: Booking request -> Trigger book_appointment tool
    if (lastUserMessage.includes('book') || lastUserMessage.includes('appointment')) {
      // Pick a date from user message or default to 2 days ahead
      let bookingDate = '';
      const dateMatch = lastUserMessage.match(/(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        bookingDate = dateMatch[1];
      } else {
        const d = new Date();
        d.setDate(d.getDate() + 2);
        if (d.getDay() === 0) d.setDate(d.getDate() + 1); // skip Sunday
        bookingDate = d.toISOString().slice(0, 10);
      }

      // Determine doctor
      let doctorId = 'dr_sharma';
      if (lastUserMessage.includes('priya')) doctorId = 'dr_priya';
      else if (lastUserMessage.includes('rajesh')) doctorId = 'dr_rajesh';
      else if (lastUserMessage.includes('ananya')) doctorId = 'dr_ananya';

      // Determine time
      let startTime = '09:30';
      const timeMatch = lastUserMessage.match(/(\d{1,2}):(\d{2})/);
      if (timeMatch) {
        const hh = timeMatch[1].padStart(2, '0');
        const mm = timeMatch[2];
        startTime = `${hh}:${mm}`;
      } else if (
        lastUserMessage.includes('shaam') ||
        lastUserMessage.includes('evening') ||
        lastUserMessage.includes('5 pm') ||
        lastUserMessage.includes('5 baje') ||
        lastUserMessage.includes('17:00')
      ) {
        startTime = '17:30';
      }

      const toolCall: ToolCall = {
        id: `call_${Date.now()}_book`,
        type: 'function',
        function: {
          name: 'book_appointment',
          arguments: JSON.stringify({
            doctorId,
            date: bookingDate,
            startTime,
            patientName: 'Rohan Sharma',
            patientPhone: '9876543210',
          }),
        },
      };

      return {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [toolCall],
        },
        tokensUsed: 120,
        isMock: true,
      };
    }

    // Intent 2: Doctor queries -> Trigger get_clinic_doctors tool
    if (lastUserMessage.includes('doctor') || lastUserMessage.includes('specialist')) {
      const toolCall: ToolCall = {
        id: `call_${Date.now()}_docs`,
        type: 'function',
        function: {
          name: 'get_clinic_doctors',
          arguments: JSON.stringify({}),
        },
      };

      return {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [toolCall],
        },
        tokensUsed: 80,
        isMock: true,
      };
    }

    // Default conversational greeting
    return {
      message: {
        role: 'assistant',
        content:
          'Namaste! Appointly clinic assistant me aapka swagat hai. <pauses> ' +
          'Aap kis doctor se aur kis date par appointment book karna chahte hain?',
      },
      tokensUsed: 60,
      isMock: true,
    };
  }
}
