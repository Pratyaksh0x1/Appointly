# Appointly: Hackathon Demonstration Script & Presentation Guide 🎙️🏥

> **Live Hinglish Voice AI Receptionist for Small Clinics in India**  
> _Built for the Gnani AI Hackathon • Powered by Neon Serverless PostgreSQL_

---

## 1. Executive Pitch (60 Seconds)

> _"In India, small clinic receptionists are overwhelmed handling over 150 daily phone calls while managing walk-in patients. Callers switch naturally between Hindi and English (code-switching / Hinglish). Traditional IVR menus fail because patients abandon them, and generic LLMs hallucinate slots or give dangerous medical advice._
>
> _Enter **Appointly**: an empathetic voice AI receptionist powered by Gnani.ai speech technology and Neon Serverless PostgreSQL. It speaks natural conversational Hinglish, adheres to non-negotiable medical non-diagnostic and emergency guardrails, guarantees **zero double-booking** through serializable PostgreSQL transactions, and updates the doctor's live dashboard in real time (<2 seconds) via transactional outbox streaming."_

---

## 2. Live Demonstration Flow (6 Core Steps)

### Step 1: Open the Doctor Dashboard & Verify Live Status

1. Open browser: **[http://localhost:3000](http://localhost:3000)**.
2. Notice the live status badge in the header:
   - 🟢 **Neon Postgres Live** (Connected via Server-Sent Events).
   - 🩺 Doctor Roster: **Dr. Ramesh Sharma** (General Physician), **Dr. Priya Patel** (Pediatrician), **Dr. Rajesh Kumar** (Cardiologist), **Dr. Ananya Iyer** (Dermatologist).
   - 📊 **Observability & SLO Tab**: View real-time 99.9% availability, latency percentiles, and error rate monitors.

---

### Step 2: Doctor Schedule Customization (OPD Hours Control)

> _Key Hackathon Requirement: Doctors can customize clinic hours (e.g. 5:00 PM to 10:00 PM), and the voice agent respects them immediately._

1. In the dashboard, switch to **Dr. Ramesh Sharma**'s profile.
2. Navigate to the **⚙️ Clinic & OPD Schedule** card.
3. Update hours:
   - **Start Time**: `17:00` (5:00 PM)
   - **End Time**: `22:00` (10:00 PM)
   - **Slot Duration**: `30 mins`
4. Click **Save Schedule**.
5. Observe:
   - Neon PostgreSQL immediately commits the change in the `doctors` table.
   - Available slots dynamically recalculate (`17:00, 17:30, 18:00 ... 21:30`).
   - The voice agent's slot generator is now synchronized without needing a server restart!

---

### Step 3: Live Hinglish Voice Booking

1. Open the interactive voice client: **[http://localhost:3000/voice-test](http://localhost:3000/voice-test)**.
2. Click **Start Live Call** (or use the CLI: `npm run chat:cli`).
3. Speak / Type:
   > **Patient**: _"Namaste, mujhe Dr. Sharma ke sath kal shaam ko appointment book karni hai. Bukhar aur khansi hai."_
4. Observe the agent's behavior:
   - **Consent & Intent**: Detects booking intent, queries open slots for tomorrow evening within the doctor's 5:00 PM – 10:00 PM window.
   - **Voice UX Constraint**: Offers strictly **at most 2 slots** on voice (_"Dr. Sharma ke paas kal shaam 5:30 baje aur 6:00 baje slots available hain. Aap kaunsa samay lena chahenge?"_).
5. Respond:
   > **Patient**: _"6:00 baje wala theek rahega. Mera naam Amit Verma hai."_
6. Agent holds the slot (2-minute auto-expiring hold), reads back doctor, date, time, and duration, and asks to confirm.
7. Confirm:
   > **Patient**: _"Haan, confirm kar dijiye."_
8. Notice:
   - Voice agent commits the transaction on Neon with an idempotency key.
   - Spoken confirmation includes clinic arrival instructions:
     _"Aapki appointment Dr. Ramesh Sharma ke saath kal shaam 6:00 baje confirm ho gayi hai. Duration: 30 minute. Kripya clinic samay se 10 minute pehle pahunchein."_

---

### Step 4: Real-Time Doctor Dashboard Reflection (< 2 Seconds)

1. Switch back to **[http://localhost:3000](http://localhost:3000)**.
2. Without refreshing the page:
   - An animated appointment card for **Amit Verma** appears in the **Today / Upcoming Appointments** list.
   - Details displayed: Doctor, Date, Time (18:00 IST), Duration (30 mins), and visit type.
   - Under **🩺 AI Call Summaries**, view the structured non-diagnostic summary:
     - _Concern (Patient's verbatim words)_: _"Bukhar aur khansi hai"_ (Strictly non-diagnostic note; no medical speculation).
     - _Outcome_: `BOOKED`.

---

### Step 5: Medical Emergency Escalation Live Bypass

1. In the voice tester or CLI, simulate an emergency utterance:
   > **Patient**: _"Mujhe bahut tez chest pain ho raha hai aur saans lene me bahut takleef ho rahi hai!"_
2. Observe immediate safety reaction:
   - **Zero LLM Hallucination**: Code-level regex safety detector triggers instantaneously ($< 1$ ms).
   - **Immediate Escalation**: Voice agent immediately interrupts and speaks the emergency protocol:
     _"Yeh ek medical emergency lag rahi hai! Kripya turant nazdeeki hospital ke emergency ward jayein ya ambulance ke liye 108 dial karein."_
   - **Dashboard Alert**: An emergency banner pulses red on the Doctor Dashboard in real time via the transactional outbox.

---

### Step 6: Observability, Metrics & SLO Verification

1. In the Doctor Dashboard, click the **📊 Observability & SLO** tab.
2. Review:
   - **SLO Status**: 99.9% Availability (MET) and p95 Turn Latency < 2.0s (MET).
   - **Per-Stage Latencies Table**: STT (p50/p95), LLM First Token (p50/p95), TTS First Audio (p50/p95), and Total Turn.
   - **Live Prometheus Feed**: Click `⚡ Prometheus (/metrics)` to inspect live Prometheus counters and quantile summaries.
3. Run the automated evaluation suite in terminal:
   ```bash
   npm run eval
   ```
   - Evaluates 61 diverse Hinglish clinical scenarios across 9 categories.
   - Emits report in `docs/eval-report.md`:
     - **Overall Pass Rate**: 100%
     - **Emergency Triage Rate**: 100%
     - **Unavailable Slots Booked**: 0

---

## 3. Key Architectural Innovations to Highlight to Judges

| Innovation                            | Hackathon Differentiation                                                                                                                                                                 |
| :------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Strict Non-Diagnostic Guarantee**   | Unlike naive GPT wrappers that diagnose chest pain or recommend medication, Appointly strictly records patient concerns verbatim and escalates life-threatening symptoms directly to 108. |
| **Zero Double-Booking Guarantee**     | Postgres `UNIQUE (doctor_id, slot_start)` constraint + row-locking (`FOR UPDATE SKIP LOCKED`) + idempotency keys prevent race conditions even under 50 concurrent callers.                |
| **Transactional Outbox Architecture** | Decouples telephony transactions from dashboard notifications. No WebSocket disconnect or SSE drop can ever lose an appointment event.                                                    |
| **Sentence-Chunked Streaming Voice**  | TTS begins generating audio on the first sentence chunk while the LLM continues reasoning, cutting perceived turn latency to under 1.5 seconds.                                           |
| **Pre-Cached Instant Audio**          | Pre-renders fixed phrases in RAM; streams 0 ms filler and emergency audio to eliminate perceived latency during network spikes or serverless cold starts.                                 |
