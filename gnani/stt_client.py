"""
Gnani Speech-to-Text (STT) Client
Supports REST transcription and Real-Time WebSocket streaming using Prisma v3.0 / v2.5.
"""

import os
import json
import asyncio
from typing import Optional, AsyncGenerator, Dict, Any
import requests
import websockets

class GnaniSTTClient:
    REST_URL = "https://api.vachana.ai/stt/v3"
    WS_URL = "wss://api.vachana.ai/stt/v3/stream"

    def __init__(self, api_key: Optional[str] = None):
        """
        Initialize the Gnani STT Client.
        :param api_key: Gnani API Key (defaults to GNANI_API_KEY environment variable).
        """
        self.api_key = api_key or os.getenv("GNANI_API_KEY")
        if not self.api_key:
            raise ValueError("Gnani API Key is required. Set GNANI_API_KEY in environment or pass api_key.")

    def transcribe_file(
        self,
        audio_path: str,
        model: str = "prisma-v3.0",
        language_code: str = "indic-auto",
        output_format: str = "transcribe",
        timeout: int = 60,
    ) -> Dict[str, Any]:
        """
        Transcribe an audio file using the Gnani STT REST API.
        
        :param audio_path: Path to the audio file (WAV, MP3, OGG, FLAC, M4A <= 30 seconds).
        :param model: 'prisma-v3.0' or 'prisma-v2.5'.
        :param language_code: 'indic-auto' (Prisma v3.0 only), or 'hi-IN', 'en-IN', 'ta-IN', etc.
        :param output_format: 'transcribe', 'verbatim', 'codemix', or 'transliterate'.
        :param timeout: Request timeout in seconds.
        :return: Dict containing API response (e.g., transcript, detected_language_code, latency).
        """
        if not os.path.exists(audio_path):
            raise FileNotFoundError(f"Audio file not found: {audio_path}")

        headers = {
            "X-API-Key-ID": self.api_key
        }
        data = {
            "model": model,
            "language_code": language_code,
            "format": output_format
        }

        with open(audio_path, "rb") as f:
            files = {
                "audio_file": (os.path.basename(audio_path), f)
            }
            response = requests.post(
                self.REST_URL,
                headers=headers,
                data=data,
                files=files,
                timeout=timeout
            )

        if response.status_code != 200:
            raise RuntimeError(f"STT API error ({response.status_code}): {response.text}")

        return response.json()

    def transcribe_bytes(
        self,
        audio_bytes: bytes,
        filename: str = "audio.wav",
        model: str = "prisma-v3.0",
        language_code: str = "indic-auto",
        output_format: str = "transcribe",
        timeout: int = 60,
    ) -> Dict[str, Any]:
        """
        Transcribe raw audio bytes using the Gnani STT REST API.
        """
        headers = {
            "X-API-Key-ID": self.api_key
        }
        data = {
            "model": model,
            "language_code": language_code,
            "format": output_format
        }
        files = {
            "audio_file": (filename, audio_bytes)
        }

        response = requests.post(
            self.REST_URL,
            headers=headers,
            data=data,
            files=files,
            timeout=timeout
        )

        if response.status_code != 200:
            raise RuntimeError(f"STT API error ({response.status_code}): {response.text}")

        return response.json()

    async def stream_transcribe(
        self,
        audio_stream: AsyncGenerator[bytes, None],
        model: str = "prisma-v3.0",
        language_code: str = "indic-auto",
        sample_rate: int = 16000,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Stream live PCM audio chunks over WebSocket to Gnani STT Realtime.
        
        :param audio_stream: Async generator yielding 16-bit mono PCM chunks (1024 bytes per frame).
        :param model: 'prisma-v3.0' or 'prisma-v2.5'.
        :param language_code: 'indic-auto' or specific locale like 'hi-IN'.
        :param sample_rate: Audio sample rate (e.g. 16000 or 8000).
        :yield: Dict events such as {"type": "transcript", "text": "...", "segment_id": "..."}.
        """
        headers = {
            "x-api-key-id": self.api_key,
            "model": model,
            "language_code": language_code,
            "x-sample-rate": str(sample_rate),
        }

        async with websockets.connect(self.WS_URL, additional_headers=headers) as ws:
            async def send_worker():
                async for chunk in audio_stream:
                    if chunk:
                        await ws.send(chunk)
                # Send commit signal at the end of the stream
                await ws.send(json.dumps({"type": "commit"}))

            send_task = asyncio.create_task(send_worker())

            try:
                async for msg in ws:
                    event = json.loads(msg)
                    yield event
                    if event.get("type") == "final" or event.get("is_final"):
                        break
            finally:
                if not send_task.done():
                    send_task.cancel()
