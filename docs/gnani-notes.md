# Gnani.ai Platform Documentation & API Notes

> **Reference Documentation for Appointly Voice Agent**  
> _Derived from official Gnani.ai documentation (https://docs.gnani.ai & https://api.vachana.ai)_

---

## 1. Platform Overview & Base Architecture

Gnani.ai builds voice AI platforms optimized for Indian languages, accents, and code-mixed speech (e.g., Hinglish: Hindi + English).

- **API Base URL**: `https://api.vachana.ai`
- **WebSocket Streaming Base URL**: `wss://api.vachana.ai`
- **Authentication**: All API requests require the platform API key passed in the HTTP/WebSocket headers:
  ```http
  X-API-Key-ID: <GNANI_API_KEY>
  ```
- **Public Pricing / Credit Model**:
  - Gnani operates on an enterprise custom quote / credit allocation model (no self-serve credit card portal).
  - Appointly Hackathon Tier: **5,000 API Credits**.
  - Appointly Cost Metering Rates:
    - **Speech-to-Text (Prisma)**: 0.10 credits per audio second (1.0 credit per 10 seconds).
    - **Text-to-Speech (Timbre)**: 0.004 credits per character (1.0 credit per 250 characters).
    - **LLM Reasoning (Evon 30B)**: 0.001 credits per token (1.0 credit per 1,000 prompt+completion tokens).
  - Enforcement Caps: **50 credits per call max**, **2,000 credits per day max**.

---

## 2. Speech-to-Text (STT) — Prisma

Prisma is Gnani's proprietary Automatic Speech Recognition (ASR) engine optimized for telephony audio, noisy outpatient clinics, regional accents, and Hinglish code-switching.

### 2.1 Available Models

- `prisma-v3.0` (**Recommended**): Next-generation Indic multilingual STT with automatic language detection (`indic-auto`) and rich output formats.
- `prisma-v2.5` (**Default fallback**): Standard production model supporting 10+ Indian languages.

### 2.2 Endpoints & Methods

| Mode              | Endpoint                                      | Protocol             | Description                                                                  |
| :---------------- | :-------------------------------------------- | :------------------- | :--------------------------------------------------------------------------- |
| **REST API**      | `POST https://api.vachana.ai/stt/v3`          | HTTPS Multipart Form | Transcribes short audio files (up to 30s per chunk).                         |
| **Streaming API** | `wss://api.vachana.ai/stt/v3/stream`          | WSS (WebSocket)      | Continuous real-time audio chunk streaming with partial & final transcripts. |
| **Batch API**     | `POST https://api.vachana.ai/stt/v3/batch`    | HTTPS                | Asynchronous batch job for bulk audio uploads.                               |
| **Languages**     | `GET https://api.vachana.ai/stt/v3/languages` | HTTPS                | Dynamic discovery of supported language codes and features.                  |

### 2.3 Audio Specifications

- **Input Formats**: WAV (Linear PCM), MP3, OGG, FLAC, AAC, M4A.
- **Sample Rates**: 8 kHz to 48 kHz (telephony PSTN: 8 kHz; broadband/VoIP: 16 kHz or 44.1 kHz).
- **Channels**: 1 (mono preferred).
- **Encoding**: 16-bit signed PCM (little-endian) for raw streams.

### 2.4 Parameters & Request Schema (REST)

```bash
curl -X POST https://api.vachana.ai/stt/v3 \
  -H "X-API-Key-ID: <GNANI_API_KEY>" \
  -F "audio_file=@recording.wav;type=audio/wav" \
  -F "model=prisma-v3.0" \
  -F "language_code=indic-auto" \
  -F "format=code-mix"
```

- `language_code`:
  - `indic-auto`: Auto-detects spoken Indic language and Hindi/English switching.
  - `hi-IN`: Explicit Hindi.
  - `en-IN`: Indian English.
  - Regional: `ta-IN`, `te-IN`, `kn-IN`, `mr-IN`, `bn-IN`, `gu-IN`, etc.
- `format`:
  - `code-mix`: Preserves natural Hinglish code-switching (e.g., _"Dr. Sharma se appointment book kijiye"_).
  - `transcribe`: Standard localized transcription.
  - `verbatim`: Strict acoustic verbatim with hesitation markers.
  - `transliterate`: Roman script transliteration.

---

## 3. Text-to-Speech (TTS) — Timbre (Beta)

Timbre is Gnani's neural Text-to-Speech engine providing natural, low-latency, empathetic Indian voice personas.

### 3.1 Available Models & Voices

- `timbre-v3.0` (**Recommended**): Supports expressive tags (`<laugh>`, `<sigh>`, `<whispers>`) and natural pacing for clinic receptionist dialogue.
- `timbre-v2.5`: Production neural TTS model.
- **Voices**:
  - `Shivani` (Female, empathetic, natural for Indian clinic reception)
  - `Pranav` (Male, clear formal tone)
  - `Kaveri` (Female, warm conversational tone)
  - `Deepak` (Male, authoritative medical tone)

### 3.2 Endpoints & Methods

| Mode                 | Endpoint                                           | Protocol                 | Description                                                                            |
| :------------------- | :------------------------------------------------- | :----------------------- | :------------------------------------------------------------------------------------- |
| **REST (Inference)** | `POST https://api.vachana.ai/api/v1/tts/inference` | HTTPS JSON               | Returns complete audio payload in a single response.                                   |
| **SSE Streaming**    | `POST https://api.vachana.ai/api/v1/tts/sse`       | HTTPS Server-Sent Events | Streams generated audio chunks as they are synthesized to minimize first-byte latency. |
| **WebSocket**        | `wss://api.vachana.ai/api/v1/tts`                  | WSS (WebSocket)          | Full-duplex interactive conversational audio streaming.                                |

### 3.3 Audio Output Containers

- `wav`: Standard WAV container with 44-byte header (16 kHz / 24 kHz mono).
- `raw`: Raw 16-bit linear PCM without container header (ideal for WebSocket streaming).
- `mp3`: Compressed MP3 stream.
- `mulaw` / `alaw`: G.711 telephony audio at 8 kHz (zero transcoding for PSTN/SIP trunks).

### 3.4 Request Schema (REST)

```json
{
  "text": "Aapka appointment Dr. Ramesh Sharma ke sath kal subah 10 baje confirm ho gaya hai.",
  "model": "timbre-v3.0",
  "voice": "Shivani",
  "language": "hi-IN",
  "speed": 1.0,
  "audio_config": {
    "container": "wav",
    "sample_rate": 16000,
    "encoding": "linear_pcm"
  }
}
```

---

## 4. Large Language Model (LLM) — Evon 30B

Evon (specifically `gnani-evon-v3.3-30b-a3b`) is Gnani’s sovereign foundation model built on a hybrid **Mamba2-Transformer Mixture-of-Experts (MoE)** architecture.

### 4.1 Model Specifications

- **Model ID**: `gnani/gnani-evon-v3.3-30b-a3b`
- **Total Parameters**: ~30 Billion parameters.
- **Active Parameters**: ~3.3 Billion active parameters per token (rapid inference, low GPU memory consumption per token).
- **Context Window**: 128,000 tokens (128K).
- **Indic Tokenizer**: Native Indic byte-level BPE tokenizer optimized to reduce token expansion for Hindi/Devanagari scripts from 3x-4x down to ~1.1x compared to LLaMA/GPT tokenizers.
- **API Access**: Exposed via OpenAI-compatible endpoints (`/v1/chat/completions`) using self-hosted `vLLM` or enterprise Gnani Plexus/Artha gateways.

### 4.2 LLM Tool Calling Protocol (OpenAI Compatible)

Appointly interfaces with Evon using standard OpenAI-compatible tool definitions:

```json
{
  "model": "gnani-evon-v3.3-30b-a3b",
  "messages": [
    {"role": "system", "content": "...system prompt..."},
    {"role": "user", "content": "Mujhe kal Dr. Sharma ka appointment chahiye"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "check_slots",
        "description": "Check available doctor appointment slots on a given date",
        "parameters": { ... }
      }
    }
  ],
  "temperature": 0.2
}
```

---

## 5. Summary of Service Configurations in Appointly

| Service | Environment Variable | Default Production URL                        | Mock Mode                                   |
| :------ | :------------------- | :-------------------------------------------- | :------------------------------------------ |
| **STT** | `GNANI_STT_URL`      | `https://api.vachana.ai/stt/v3`               | Simulates transcript without API hit        |
| **TTS** | `GNANI_TTS_URL`      | `https://api.vachana.ai/api/v1/tts/inference` | Generates 16kHz synthetic PCM tone          |
| **LLM** | `EVON_BASE_URL`      | Configurable OpenAI URL                       | Rule-based tool-calling simulated responses |
