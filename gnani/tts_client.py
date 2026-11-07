"""
Gnani Text-to-Speech (TTS) Client
Supports REST synthesis, SSE streaming, and Real-Time WebSocket streaming using Timbre v3.0 / v2.5.
"""

import os
import json
import base64
import asyncio
from typing import Optional, AsyncGenerator, Dict, Any
import requests
import websockets

class GnaniTTSClient:
    REST_URL = "https://api.vachana.ai/api/v1/tts/inference"
    SSE_URL = "https://api.vachana.ai/api/v1/tts/sse"
    WS_URL = "wss://api.vachana.ai/api/v1/tts"

    # Known voices
    TIMBRE_V30_VOICES = [
        "Avinash", "Chetana", "Devansh", "Harshad", "Kalpana", "Lakshmi",
        "Prakash", "Riyaa", "Shivani", "Shubham", "Tarika", "Vasudha", "Yashraj"
    ]

    def __init__(self, api_key: Optional[str] = None):
        """
        Initialize the Gnani TTS Client.
        :param api_key: Gnani API Key (defaults to GNANI_API_KEY environment variable).
        """
        self.api_key = api_key or os.getenv("GNANI_API_KEY")
        if not self.api_key:
            raise ValueError("Gnani API Key is required. Set GNANI_API_KEY in environment or pass api_key.")

    def synthesize(
        self,
        text: str,
        output_file: Optional[str] = None,
        voice: str = "Shivani",
        model: str = "timbre-v3.0",
        language: str = "hi-IN",
        speed: float = 1.0,
        sample_rate: int = 24000,
        container: str = "wav",
        timeout: int = 60,
    ) -> bytes:
        """
        Synthesize text into speech using Gnani TTS REST API.
        
        :param text: Text to speak (supports audio tags like <pauses> on Timbre v3.0).
        :param output_file: Optional file path to save audio to (.wav).
        :param voice: Voice name (e.g., 'Shivani', 'Avinash' for timbre-v3.0).
        :param model: 'timbre-v3.0' or 'timbre-v2.5'.
        :param language: Language code, e.g., 'hi-IN', 'en-IN', or 'auto'.
        :param speed: Speaking rate (0.85 to 1.15).
        :param sample_rate: Audio sample rate in Hz (e.g. 16000, 24000, 48000).
        :param container: Audio container format ('wav' or 'raw').
        :param timeout: Request timeout in seconds.
        :return: Raw audio bytes.
        """
        headers = {
            "Content-Type": "application/json",
            "X-API-Key-ID": self.api_key,
        }

        payload = {
            "text": text,
            "voice": voice,
            "model": model,
            "language": language,
            "speed": speed,
            "audio_config": {
                "sample_rate": sample_rate,
                "num_channels": 1,
                "sample_width": 2,
                "encoding": "linear_pcm",
                "container": container,
            },
        }

        response = requests.post(
            self.REST_URL,
            headers=headers,
            json=payload,
            timeout=timeout
        )

        if response.status_code != 200:
            raise RuntimeError(f"TTS API error ({response.status_code}): {response.text}")

        audio_bytes = response.content

        if output_file:
            os.makedirs(os.path.dirname(os.path.abspath(output_file)), exist_ok=True)
            with open(output_file, "wb") as f:
                f.write(audio_bytes)

        return audio_bytes

    async def stream_synthesize_sse(
        self,
        text: str,
        voice: str = "Shivani",
        model: str = "timbre-v3.0",
        language: str = "hi-IN",
        speed: float = 1.0,
        sample_rate: int = 24000,
    ) -> AsyncGenerator[bytes, None]:
        """
        Stream synthesized speech chunks using Server-Sent Events (SSE).
        Yields raw PCM audio chunk bytes.
        """
        headers = {
            "Content-Type": "application/json",
            "X-API-Key-ID": self.api_key,
        }

        payload = {
            "text": text,
            "voice": voice,
            "model": model,
            "language": language,
            "speed": speed,
            "audio_config": {
                "sample_rate": sample_rate,
                "encoding": "linear_pcm",
                "container": "wav",
            },
        }

        # Using requests stream for SSE
        with requests.post(self.SSE_URL, headers=headers, json=payload, stream=True) as r:
            if r.status_code != 200:
                raise RuntimeError(f"TTS SSE error ({r.status_code}): {r.text}")

            for line in r.iter_lines():
                if line:
                    decoded = line.decode("utf-8")
                    if decoded.startswith("data:"):
                        data_str = decoded[len("data:"):].strip()
                        try:
                            data_json = json.loads(data_str)
                            if "audio" in data_json and data_json["audio"]:
                                audio_chunk = base64.b64decode(data_json["audio"])
                                yield audio_chunk
                            if data_json.get("is_final", False):
                                break
                        except json.JSONDecodeError:
                            continue
