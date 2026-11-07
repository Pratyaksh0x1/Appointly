"""
Quick Test Script for Gnani Text-to-Speech (TTS)
Synthesizes a sample clinic greeting in Hindi / English using Timbre v3.0.
"""

import os
import sys
from dotenv import load_dotenv
from gnani.tts_client import GnaniTTSClient

# Load environment variables from .env file
load_dotenv()

def main():
    api_key = os.getenv("GNANI_API_KEY")
    if not api_key or api_key == "your_gnani_api_key_here":
        print("\n[ERROR] GNANI_API_KEY is not configured!")
        print("Please set your API key in the .env file or pass it as an environment variable.")
        print("Example in .env:")
        print("  GNANI_API_KEY=your_actual_api_key\n")
        sys.exit(1)

    print("=== Testing Gnani TTS (Timbre v3.0) ===")
    tts_client = GnaniTTSClient(api_key=api_key)

    sample_text = (
        "नमस्ते! आरोग्य केयर क्लिनिक में आपका स्वागत है। <pauses> "
        "मैं आपकी डॉक्टर अपॉइंटमेंट बुक करने और क्लिनिक की जानकारी देने में सहायता कर सकती हूँ। "
        "बताइए मैं आपकी क्या मदद करूँ?"
    )

    output_wav = os.path.join(os.path.dirname(__file__), "output", "clinic_greeting.wav")
    print(f"Synthesizing text:\n\"{sample_text}\"\n")
    print("Voice: Shivani | Model: timbre-v3.0 | Language: hi-IN")

    try:
        audio_data = tts_client.synthesize(
            text=sample_text,
            output_file=output_wav,
            voice=os.getenv("GNANI_TTS_VOICE", "Shivani"),
            model=os.getenv("GNANI_TTS_MODEL", "timbre-v3.0"),
            language=os.getenv("GNANI_TTS_LANGUAGE", "hi-IN"),
            speed=float(os.getenv("GNANI_TTS_SPEED", "1.0")),
        )
        print(f"\n[SUCCESS] Synthesized {len(audio_data)} bytes of audio!")
        print(f"Audio file saved to: {output_wav}")
    except Exception as e:
        print(f"\n[FAILED] TTS synthesis failed: {e}")

if __name__ == "__main__":
    main()
