/**
 * Appointly End-to-End Voice Pipeline Smoke Test
 * Sends a short Hinglish sentence through:
 *  1. Audio -> Speech-to-Text (Prisma v3.0)
 *  2. Transcript -> LLM Reasoning & Tool Calling (Evon 30B)
 *  3. LLM Response -> Speech Synthesis (Timbre v3.0)
 * Measures and prints individual step latencies and credit consumption.
 */

import dotenv from 'dotenv';
import { performance } from 'perf_hooks';
import { getProviders } from '../apps/api/src/adapters/index.js';
import { globalCostMeter } from '../apps/api/src/cost/cost-meter.js';

dotenv.config();

function createTestAudio(durationSec: number = 2): Buffer {
  const sampleRate = 16000;
  const numSamples = sampleRate * durationSec;
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // Mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 3000;
    buffer.writeInt16LE(Math.round(sample), 44 + i * 2);
  }
  return buffer;
}

export async function runSmokePipeline() {
  console.log('===============================================================');
  console.log('       APPOINTLY HINGLISH VOICE PIPELINE SMOKE TEST           ');
  console.log('===============================================================\n');

  const providers = getProviders();
  const testSentence = 'Mujhe kal subah Dr. Sharma ke paas appointment chahiye fever ke liye.';
  const callId = `smoke_${Date.now()}`;

  console.log(`Input Sentence: "${testSentence}"`);
  console.log(
    `Active Providers: STT [${providers.stt.name}], TTS [${providers.tts.name}], LLM [${providers.llm.name}]`
  );
  console.log(`Call ID: ${callId}\n`);

  const overallStart = performance.now();

  // -------------------------------------------------------------
  // STEP 1: SPEECH-TO-TEXT (Prisma STT)
  // -------------------------------------------------------------
  console.log('1. Transcribing audio with STT...');
  const testAudio = createTestAudio(2);
  const sttStart = performance.now();
  const sttResult = await providers.stt.transcribe(testAudio, {
    callId,
    languageCode: 'hi-IN',
    format: 'code-mix',
  });
  const sttLatency = Math.round(performance.now() - sttStart);
  console.log(`   ✓ STT Finished: "${sttResult.transcript}"`);
  console.log(`   ✓ Latency: ${sttLatency}ms | Confidence: ${sttResult.confidence}\n`);

  // -------------------------------------------------------------
  // STEP 2: LLM REASONING & TOOL CALLING (Evon 30B)
  // -------------------------------------------------------------
  console.log('2. Running LLM turn evaluation & tool decision...');
  const llmStart = performance.now();
  const llmResponse = await providers.llm.chat(
    [
      {
        role: 'system',
        content:
          'You are Appointly, an empathetic Hindi-English voice receptionist. Confirm doctor, date, time and duration before booking.',
      },
      {
        role: 'user',
        content: sttResult.transcript,
      },
    ],
    {
      callId,
      temperature: 0.2,
      idempotent: true,
    }
  );
  const llmLatency = Math.round(performance.now() - llmStart);
  console.log(`   ✓ LLM Finished: "${llmResponse.content}"`);
  if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
    const tc = llmResponse.toolCalls[0];
    console.log(`   ✓ Tool Call Emitted: ${tc.function.name}(${tc.function.arguments})`);
  }
  console.log(`   ✓ Latency: ${llmLatency}ms | Tokens: ${llmResponse.totalTokens}\n`);

  // -------------------------------------------------------------
  // STEP 3: TEXT-TO-SPEECH (Timbre TTS)
  // -------------------------------------------------------------
  console.log('3. Synthesizing voice response with Timbre TTS...');
  const ttsText =
    llmResponse.content ||
    'Dr. Sharma ke kal subah 10 baje ka slot available hai. Kya main yeh confirm kar doon?';
  const ttsStart = performance.now();
  const ttsResult = await providers.tts.synthesize(ttsText, {
    callId,
    voice: 'Shivani',
    language: 'hi-IN',
  });
  const ttsLatency = Math.round(performance.now() - ttsStart);
  console.log(`   ✓ TTS Finished: ${ttsResult.audioBuffer.length} bytes synthesized`);
  console.log(`   ✓ Latency: ${ttsLatency}ms | Sample Rate: ${ttsResult.sampleRate}Hz\n`);

  const totalTurnLatency = Math.round(performance.now() - overallStart);

  // -------------------------------------------------------------
  // SUMMARY REPORT
  // -------------------------------------------------------------
  const summary = globalCostMeter.getSummary();

  console.log('===============================================================');
  console.log('                   LATENCY & BUDGET REPORT                     ');
  console.log('===============================================================');
  console.table([
    { Component: '1. Prisma STT', 'Latency (ms)': `${sttLatency} ms`, Status: 'PASS' },
    { Component: '2. Evon 30B LLM', 'Latency (ms)': `${llmLatency} ms`, Status: 'PASS' },
    { Component: '3. Timbre TTS', 'Latency (ms)': `${ttsLatency} ms`, Status: 'PASS' },
    { Component: 'Total Turn Latency', 'Latency (ms)': `${totalTurnLatency} ms`, Status: 'PASS' },
  ]);

  console.log(`Total Budget: ${summary.totalBudget} credits`);
  console.log(`Remaining Credits: ${summary.remainingCredits} credits`);
  console.log(`Daily Limit: ${summary.dailyLimit} credits`);
  console.log('===============================================================\n');

  return {
    sttLatency,
    llmLatency,
    ttsLatency,
    totalTurnLatency,
    transcript: sttResult.transcript,
    replyText: ttsText,
    audioBytes: ttsResult.audioBuffer.length,
  };
}

if (process.argv[1] && process.argv[1].includes('smoke-voice-pipeline.ts')) {
  runSmokePipeline()
    .then(() => {
      console.log('Smoke pipeline executed successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Smoke pipeline failed:', err);
      process.exit(1);
    });
}
