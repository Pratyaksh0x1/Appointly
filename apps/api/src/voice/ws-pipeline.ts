/**
 * Appointly Realtime WebSocket Voice Pipeline
 * Coordinates live two-way telephony voice sessions:
 * - Audio Ingest -> VAD -> STT -> Orchestrator -> Sentence-Chunked TTS -> Audio Stream
 * - Token-based authentication
 * - Barge-in interruption
 * - 700ms tool call filler phrases
 * - Latency telemetry & debug panel metrics
 * - Pre-generated fixed audio caching
 */

import { WebSocket, WebSocketServer } from 'ws';
import http from 'http';
import { validateVoiceSessionToken, markVoiceSessionTokenUsed } from './session-manager.js';
import { VoiceActivityDetector } from './vad.js';
import { splitIntoSentences } from './sentence-chunker.js';
import { TurnMetricsTracker, globalLatencyCollector } from './timing-metrics.js';
import { getCachedAudio, FIXED_PHRASES, initAudioCache } from './audio-cache.js';
import {
  createSession,
  processConversationTurn,
  ConversationSession,
} from '../agent/orchestrator.js';
import { getProviders } from '../adapters/index.js';
import { rootLogger, maskPhone } from '../logger/logger.js';
import { globalCostMeter } from '../cost/cost-meter.js';
import { broadcastDashboardEvent } from '../index.js';

const MAX_CALL_DURATION_MS = 5 * 60 * 1000; // 5 minutes max call limit
const IDLE_TIMEOUT_MS = 45 * 1000; // 45 seconds idle timeout
const FILLER_THRESHOLD_MS = 700; // Trigger filler phrase if tool call > 700ms

export interface ClientControlMessage {
  type: 'start_session' | 'speech_end' | 'interrupt' | 'ping';
  patientPhone?: string;
  doctorId?: string;
}

export class RealtimeVoiceSession {
  private ws: WebSocket;
  private callId: string;
  private vad: VoiceActivityDetector;
  private metricsTracker: TurnMetricsTracker;
  private conversationSession: ConversationSession;
  private turnIndex: number = 0;
  private isAgentSpeaking: boolean = false;
  private isProcessingTurn: boolean = false;
  private abortController: AbortController | null = null;
  private accumulatedAudioChunks: Buffer[] = [];
  private callTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private isClosed: boolean = false;

  constructor(ws: WebSocket, callId: string, patientPhone: string = '9876543210') {
    this.ws = ws;
    this.callId = callId;
    this.vad = new VoiceActivityDetector();
    this.metricsTracker = new TurnMetricsTracker(callId);
    this.conversationSession = createSession(patientPhone, callId);

    this.startCallTimers();
  }

  /**
   * Initializes session: sends ready event and pre-cached greeting audio.
   */
  public async initialize(): Promise<void> {
    rootLogger.info(`[VoiceSession] Starting realtime session ${this.callId}`);

    // Send session_ready event
    this.sendEvent({
      type: 'session_ready',
      callId: this.callId,
      state: this.conversationSession.state,
      maxDurationSec: MAX_CALL_DURATION_MS / 1000,
    });

    // Play pre-cached greeting
    await this.playGreeting();
  }

  /**
   * Plays pre-cached greeting audio in 0 ms.
   */
  private async playGreeting(): Promise<void> {
    const greetingText = FIXED_PHRASES.GREETING;
    this.conversationSession.state = 'UNDERSTAND_INTENT';

    this.sendEvent({
      type: 'agent_text',
      text: greetingText,
      state: this.conversationSession.state,
    });

    const cached = getCachedAudio('GREETING');
    if (cached) {
      this.sendAudioChunk(cached.audioBuffer, 0, true);
    } else {
      // Synthesize on the fly
      const tts = getProviders().tts;
      const res = await tts.synthesize(greetingText, { callId: this.callId });
      this.sendAudioChunk(res.audioBuffer, 0, true);
    }
  }

  /**
   * Handles binary audio chunks received from browser mic.
   */
  public async handleAudioChunk(chunk: Buffer): Promise<void> {
    if (this.isClosed) return;
    this.resetIdleTimer();

    // Run VAD
    const vadRes = this.vad.processChunk(chunk);

    // 1. BARGE-IN DETECTION: Patient started speaking while agent was speaking
    if (vadRes.isSpeechStart && this.isAgentSpeaking) {
      rootLogger.info(`[VoiceSession] Barge-in triggered by caller speech`, {
        callId: this.callId,
      });
      this.handleBargeIn();
    }

    // 2. ACCUMULATE AUDIO DURING ACTIVE SPEECH
    if (vadRes.isSpeaking) {
      this.accumulatedAudioChunks.push(chunk);
    }

    // 3. END-OF-SPEECH TRIGGER (VAD silence threshold reached)
    if (vadRes.isSpeechEnd && this.accumulatedAudioChunks.length > 0 && !this.isProcessingTurn) {
      const fullSpeechBuffer = Buffer.concat(this.accumulatedAudioChunks);
      this.accumulatedAudioChunks = [];
      await this.processCallerTurn(fullSpeechBuffer);
    }
  }

  /**
   * Executes Barge-in: stops agent audio and notifies client to purge audio buffer.
   */
  public handleBargeIn(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.isAgentSpeaking = false;
    this.sendEvent({ type: 'interrupt', message: 'Audio playback interrupted by user speech' });
  }

  /**
   * Handles textual control messages from client.
   */
  public async handleControlMessage(msg: ClientControlMessage): Promise<void> {
    if (msg.type === 'interrupt') {
      this.handleBargeIn();
    } else if (msg.type === 'speech_end') {
      if (this.accumulatedAudioChunks.length > 0 && !this.isProcessingTurn) {
        const fullAudio = Buffer.concat(this.accumulatedAudioChunks);
        this.accumulatedAudioChunks = [];
        await this.processCallerTurn(fullAudio);
      }
    } else if (msg.type === 'ping') {
      this.sendEvent({ type: 'pong', timestamp: Date.now() });
    }
  }

  /**
   * Processes a complete conversational turn after end-of-speech.
   */
  public async processCallerTurn(audioBuffer: Buffer, overrideText?: string): Promise<void> {
    if (this.isProcessingTurn || this.isClosed) return;
    this.isProcessingTurn = true;
    this.turnIndex++;
    const speechEndTs = Date.now();
    this.metricsTracker.startTurn(this.turnIndex, speechEndTs);

    this.sendEvent({ type: 'state', state: 'PROCESSING', turnIndex: this.turnIndex });

    this.abortController = new AbortController();
    const abortSignal = this.abortController.signal;

    try {
      // ==========================================
      // 1. STREAMING STT (Speech-to-Text)
      // ==========================================
      let transcript = overrideText;
      if (!transcript) {
        const stt = getProviders().stt;
        const sttRes = await stt.transcribe(audioBuffer, {
          callId: this.callId,
          languageCode: 'hi-IN',
        });
        transcript = sttRes.transcript;
      }

      this.metricsTracker.markSttDone();
      rootLogger.info(`[VoiceSession] Turn ${this.turnIndex} Transcript: "${transcript}"`, {
        callId: this.callId,
        transcript,
      });

      this.sendEvent({
        type: 'transcript',
        text: transcript,
        isFinal: true,
        turnIndex: this.turnIndex,
      });

      if (!transcript || transcript.trim().length === 0) {
        this.isProcessingTurn = false;
        return;
      }

      // ==========================================
      // 2. TOOL 700MS FILLER PHRASE PROTOCOL
      // ==========================================
      let fillerTriggered = false;
      const fillerTimer = setTimeout(() => {
        if (!abortSignal.aborted && this.isProcessingTurn) {
          fillerTriggered = true;
          rootLogger.info(`[VoiceSession] Tool call > 700ms. Delivering filler phrase.`, {
            callId: this.callId,
          });
          const fillerText = FIXED_PHRASES.FILLER;
          this.sendEvent({ type: 'filler', text: fillerText });

          const cachedFiller = getCachedAudio('FILLER');
          if (cachedFiller) {
            this.sendAudioChunk(cachedFiller.audioBuffer, 0, false);
          }
        }
      }, FILLER_THRESHOLD_MS);

      // ==========================================
      // 3. ORCHESTRATOR / CONVERSATION BRAIN
      // ==========================================
      const orchestratorResponse = await processConversationTurn(
        this.conversationSession,
        transcript
      );
      clearTimeout(fillerTimer);

      this.metricsTracker.markLlmFirstToken();

      if (abortSignal.aborted) {
        rootLogger.info('[VoiceSession] Turn aborted during orchestrator execution');
        this.isProcessingTurn = false;
        return;
      }

      const replyText = orchestratorResponse.replyText;

      this.sendEvent({
        type: 'agent_text',
        text: replyText,
        state: orchestratorResponse.state,
        turnIndex: this.turnIndex,
        isTerminal: orchestratorResponse.isTerminal,
      });

      // Broadcast dashboard event if appointment booked
      if (orchestratorResponse.confirmedBooking) {
        broadcastDashboardEvent('appointment_booked', orchestratorResponse.confirmedBooking);
      }

      // ==========================================
      // 4. SENTENCE-CHUNKED STREAMING TTS
      // ==========================================
      this.isAgentSpeaking = true;
      const tts = getProviders().tts;

      // Check if entire reply is pre-cached
      const cachedReply = getCachedAudio(replyText);
      if (cachedReply) {
        this.metricsTracker.markTtsFirstAudio(true);
        this.sendAudioChunk(cachedReply.audioBuffer, 0, true);
      } else {
        // Break into sentences for rapid streaming playback
        const sentences = splitIntoSentences(replyText);
        for (let i = 0; i < sentences.length; i++) {
          if (abortSignal.aborted) break;

          const sentence = sentences[i];
          const cachedSentence = getCachedAudio(sentence);

          let sentenceAudio: Buffer;
          if (cachedSentence) {
            sentenceAudio = cachedSentence.audioBuffer;
            if (i === 0) this.metricsTracker.markTtsFirstAudio(true);
          } else {
            const ttsRes = await tts.synthesize(sentence, {
              callId: this.callId,
              language: 'hi-IN',
            });
            sentenceAudio = ttsRes.audioBuffer;
            if (i === 0) this.metricsTracker.markTtsFirstAudio(false);
          }

          if (abortSignal.aborted) break;

          const isFinalChunk = i === sentences.length - 1;
          this.sendAudioChunk(sentenceAudio, i, isFinalChunk);
        }
      }

      // ==========================================
      // 5. LATENCY TELEMETRY & DEBUG METRICS
      // ==========================================
      const metrics = this.metricsTracker.finalizeMetrics();
      this.sendEvent({
        type: 'latency',
        metrics,
        summary: globalLatencyCollector.getSummary(),
      });

      if (orchestratorResponse.isTerminal) {
        rootLogger.info(`[VoiceSession] Terminal state reached: ${orchestratorResponse.state}`, {
          callId: this.callId,
        });
        setTimeout(() => this.teardown('CALL_COMPLETED_SUCCESS'), 3000);
      }
    } catch (err) {
      rootLogger.error(`[VoiceSession] Turn error in ${this.callId}:`, err);
      this.sendEvent({
        type: 'error',
        message: 'Maaf kijiye, system mein takneeki dikkat aayi hai.',
      });
    } finally {
      this.isProcessingTurn = false;
      this.abortController = null;
    }
  }

  private sendEvent(event: Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  private sendAudioChunk(audioBuffer: Buffer, chunkIndex: number, isFinal: boolean): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      // Send binary frame containing WAV / PCM audio
      this.ws.send(audioBuffer, { binary: true });
      // Send accompanying metadata
      this.sendEvent({
        type: 'audio_meta',
        chunkIndex,
        isFinal,
        byteLength: audioBuffer.length,
      });
    }
  }

  private startCallTimers(): void {
    // Max call limit timer
    this.callTimer = setTimeout(() => {
      rootLogger.info(`[VoiceSession] Max call duration reached for ${this.callId}`);
      this.sendEvent({
        type: 'call_ended',
        reason: 'MAX_DURATION_EXCEEDED',
        message: 'Call time limit reached. Arogya Clinic se call karne ke liye shukriya.',
      });
      this.teardown('MAX_DURATION');
    }, MAX_CALL_DURATION_MS);
    this.callTimer.unref();

    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      rootLogger.info(`[VoiceSession] Idle timeout reached for ${this.callId}`);
      this.sendEvent({
        type: 'idle_warning',
        message: 'Kya aap line par hain?',
      });
    }, IDLE_TIMEOUT_MS);
    this.idleTimer.unref();
  }

  public teardown(reason: string = 'NORMAL_DISCONNECT'): void {
    if (this.isClosed) return;
    this.isClosed = true;

    if (this.callTimer) {
      clearTimeout(this.callTimer);
      this.callTimer = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    rootLogger.info(`[VoiceSession] Session closed: ${this.callId} (${reason})`, {
      callId: this.callId,
      turnsCompleted: this.turnIndex,
      reason,
    });

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, reason);
    }
  }
}

/**
 * Attaches the WebSocket Voice Server to an existing HTTP Server
 */
export function setupVoiceWebSocketServer(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('close', () => {
    wss.close();
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/ws/voice') {
      const token = url.searchParams.get('token');
      if (!token) {
        rootLogger.warn('[VoiceWS] Missing token in WebSocket upgrade request');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const authRecord = validateVoiceSessionToken(token);
      if (!authRecord) {
        rootLogger.warn('[VoiceWS] Invalid or expired token rejected during upgrade');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      markVoiceSessionTokenUsed(token);

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, authRecord);
      });
    }
  });

  wss.on('connection', async (ws: WebSocket, req: http.IncomingMessage, authRecord: any) => {
    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const patientPhone = authRecord?.patientPhone || '9876543210';

    rootLogger.info(`[VoiceWS] Authenticated WebSocket connected: ${callId}`, {
      callId,
      patientPhoneMasked: maskPhone(patientPhone),
    });

    const session = new RealtimeVoiceSession(ws, callId, patientPhone);

    ws.on('message', async (data: Buffer | string, isBinary: boolean) => {
      try {
        if (isBinary) {
          await session.handleAudioChunk(data as Buffer);
        } else {
          const parsed = JSON.parse(data.toString());
          await session.handleControlMessage(parsed);
        }
      } catch (err) {
        rootLogger.error(`[VoiceWS] Message handling error in ${callId}:`, err);
      }
    });

    ws.on('close', (code, reason) => {
      rootLogger.info(`[VoiceWS] Client disconnected ${callId} code=${code}`, {
        callId,
        code,
        reason: reason.toString(),
      });
      session.teardown('CLIENT_DISCONNECT');
    });

    ws.on('error', (err) => {
      rootLogger.error(`[VoiceWS] Socket error in ${callId}:`, err);
      session.teardown('SOCKET_ERROR');
    });

    // Initialize session with greeting
    await session.initialize();
  });

  return wss;
}
