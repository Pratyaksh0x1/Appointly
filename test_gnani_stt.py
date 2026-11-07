"""
Quick Test Script for Gnani Speech-to-Text (STT)
Transcribes an audio file using Prisma v3.0 with automatic Indic language detection.
"""

import os
import sys
import argparse
from dotenv import load_dotenv
from gnani.stt_client import GnaniSTTClient

# Load environment variables from .env file
load_dotenv()

def main():
    parser = argparse.ArgumentParser(description="Test Gnani STT with an audio file.")
    parser.add_argument(
        "--file",
        type=str,
        default="output/clinic_greeting.wav",
        help="Path to audio file (WAV/MP3 <= 30 seconds)"
    )
    parser.add_argument(
        "--model",
        type=str,
        default=os.getenv("GNANI_STT_MODEL", "prisma-v3.0"),
        help="Model: prisma-v3.0 or prisma-v2.5"
    )
    parser.add_argument(
        "--lang",
        type=str,
        default=os.getenv("GNANI_STT_LANGUAGE", "indic-auto"),
        help="Language code: indic-auto, hi-IN, en-IN, etc."
    )
    args = parser.parse_args()

    api_key = os.getenv("GNANI_API_KEY")
    if not api_key or api_key == "your_gnani_api_key_here":
        print("\n[ERROR] GNANI_API_KEY is not configured!")
        print("Please set your API key in the .env file or pass it as an environment variable.")
        print("Example in .env:")
        print("  GNANI_API_KEY=your_actual_api_key\n")
        sys.exit(1)

    if not os.path.exists(args.file):
        print(f"\n[ERROR] Audio file not found at: {args.file}")
        print("Tip: Run `python test_gnani_tts.py` first to generate a sample WAV file in output/.")
        sys.exit(1)

    print("=== Testing Gnani STT (Prisma v3.0) ===")
    print(f"File: {args.file}")
    print(f"Model: {args.model}")
    print(f"Language: {args.lang}\n")

    stt_client = GnaniSTTClient(api_key=api_key)

    try:
        result = stt_client.transcribe_file(
            audio_path=args.file,
            model=args.model,
            language_code=args.lang
        )
        print("\n[SUCCESS] STT Transcription Result:")
        print(f"  Transcript:             {result.get('transcript')}")
        print(f"  Detected Language:      {result.get('detected_language_code')}")
        print(f"  Processing Time:        {result.get('processing_time')}s")
        print(f"  End-to-End Latency:     {result.get('end_to_end_latency')}s")
    except Exception as e:
        print(f"\n[FAILED] STT transcription failed: {e}")

if __name__ == "__main__":
    main()
