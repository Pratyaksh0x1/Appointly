"""
Interactive Clinic Voice Agent CLI
Simulates a patient-receptionist conversation loop using Gnani TTS and STT.
"""

import os
import sys
from dotenv import load_dotenv
from gnani.tts_client import GnaniTTSClient
from clinic.conversation import ClinicDialogueManager

load_dotenv()

def main():
    api_key = os.getenv("GNANI_API_KEY")
    has_api_key = bool(api_key and api_key != "your_gnani_api_key_here")

    print("=" * 60)
    print("      🏥 Arogya Care Clinic - Voice AI Assistant 🏥")
    print("=" * 60)
    
    if not has_api_key:
        print("\n[NOTE] GNANI_API_KEY is not set in .env. Running in Text-Only Preview mode.")
        print("To enable voice synthesis, add your API key to .env.\n")
        tts_client = None
    else:
        print("\n[INFO] Gnani Voice AI initialized (Timbre v3.0 / Shivani).")
        tts_client = GnaniTTSClient(api_key=api_key)

    dialogue_manager = ClinicDialogueManager()
    os.makedirs("output", exist_ok=True)

    turn = 1
    # Initial greeting
    initial_text = dialogue_manager.process_message("")
    print(f"\n[AI Receptionist]: {initial_text}")
    
    if tts_client:
        try:
            greeting_audio = tts_client.synthesize(
                text=initial_text,
                output_file="output/greeting.wav",
                voice=os.getenv("GNANI_TTS_VOICE", "Shivani"),
                language=os.getenv("GNANI_TTS_LANGUAGE", "hi-IN")
            )
            print("🔊 [Audio response saved to output/greeting.wav]")
        except Exception as e:
            print(f"[Warning] Voice synthesis error: {e}")

    print("\n(Type your query in Hindi/English/Hinglish, or type 'quit' / 'exit' to end)")
    print("-" * 60)

    while True:
        try:
            user_input = input("\n[Patient]: ").strip()
            if not user_input:
                continue

            if user_input.lower() in ["quit", "exit", "bye", "अलविदा"]:
                farewell = "आरोग्य केयर क्लिनिक से संपर्क करने के लिए धन्यवाद! आपका स्वास्थ्य अच्छा रहे। नमस्ते!"
                print(f"\n[AI Receptionist]: {farewell}")
                if tts_client:
                    tts_client.synthesize(farewell, output_file="output/farewell.wav")
                    print("🔊 [Audio response saved to output/farewell.wav]")
                break

            response_text = dialogue_manager.process_message(user_input)
            print(f"\n[AI Receptionist]: {response_text}")

            if tts_client:
                audio_file = f"output/turn_{turn}.wav"
                try:
                    tts_client.synthesize(
                        text=response_text,
                        output_file=audio_file,
                        voice=os.getenv("GNANI_TTS_VOICE", "Shivani"),
                        language=os.getenv("GNANI_TTS_LANGUAGE", "hi-IN")
                    )
                    print(f"🔊 [Audio response saved to {audio_file}]")
                except Exception as e:
                    print(f"[Warning] Voice synthesis error: {e}")

            turn += 1

        except (KeyboardInterrupt, EOFError):
            print("\nSession ended.")
            break

if __name__ == "__main__":
    main()
