# Clinic Voice Agent (Powered by Gnani.ai Voice AI)

A multilingual voice-enabled receptionist assistant for **Arogya Care Clinic**, supporting Hindi, Indian English, and regional Indic languages using Gnani.ai Speech APIs.

---

## Features

- **Gnani Prisma v3.0 STT**:
  - Automatic Indic language detection (`indic-auto`).
  - Code-mixing / Hinglish support and clinical keyword bias.
  - REST and Realtime streaming WebSocket clients.
- **Gnani Timbre v3.0 TTS**:
  - Expressive bilingual voices (default: `Shivani`).
  - Native audio tags support (`<pauses>`) for human-like conversational cadence.
  - REST, SSE, and Realtime streaming clients.
- **Clinic Management Domain**:
  - Doctor profiles (General Medicine, Pediatrics, Cardiology, Dermatology).
  - Clinic hours, consultation fees, and address.
  - Emergency triage guidance.
  - Interactive conversation simulator.

---

## Project Structure

```
clinic voice agent/
├── .env.example              # Template for API keys and voice configurations
├── requirements.txt          # Python dependencies
├── README.md                 # Project documentation
├── gnani/
│   ├── __init__.py
│   ├── stt_client.py         # Prisma v3.0 REST & Realtime WebSocket client
│   └── tts_client.py         # Timbre v3.0 REST & Realtime WebSocket client
├── clinic/
│   ├── __init__.py
│   ├── knowledge_base.py     # Clinic data (doctors, timings, fees, services)
│   └── conversation.py       # Dialogue manager & response generator
├── test_gnani_tts.py         # Standalone test script for TTS
├── test_gnani_stt.py         # Standalone test script for STT
└── app.py                    # Interactive Voice Agent CLI simulator
```

---

## Setup Instructions

### 1. Configure Your API Key
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Open `.env` and fill in your Gnani API key:
```ini
GNANI_API_KEY=your_gnani_api_key_here
```

### 2. Install Dependencies
```bash
pip install -r requirements.txt
```

---

## Testing Gnani Voice APIs

### Test Text-to-Speech (TTS)
Synthesizes a sample clinic greeting into `output/clinic_greeting.wav`:
```bash
python test_gnani_tts.py
```

### Test Speech-to-Text (STT)
Transcribes an audio file using Prisma v3.0 with automatic language detection:
```bash
python test_gnani_stt.py --file output/clinic_greeting.wav
```

---

## Running the Clinic Voice Agent

Start the interactive clinic receptionist simulator:
```bash
python app.py
```
*(If run without an API key, it will run in text-only preview mode; once the API key is added, it will automatically synthesize voice responses into the `output/` folder).*
