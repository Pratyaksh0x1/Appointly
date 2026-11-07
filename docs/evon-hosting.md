# Evon 30B Self-Hosting Guide (OpenAI-Compatible Deployment)

> **Deployment Guide for Gnani Evon 30B LLM (`gnani-evon-v3.3-30b-a3b`)**  
> _Hybrid Mamba2-Transformer Mixture-of-Experts (MoE) Architecture for Indic Voice AI_

---

## 1. Overview & Model Architecture

Gnani’s **Evon** is an open-weight foundation model tailored for sovereign AI in India:

- **Hugging Face Model Card**: [`gnani/gnani-evon-v3.3-30b-a3b`](https://huggingface.co/gnani/gnani-evon-v3.3-30b-a3b)
- **Architecture**: Hybrid Mamba2 State-Space Model + Transformer Mixture-of-Experts (MoE).
- **Total Parameters**: ~30 Billion parameters.
- **Active Parameters**: ~3.3 Billion active parameters per token.
- **Context Window**: 128,000 tokens (128K).
- **Indic Tokenizer**: Native Indic BPE tokenizer reducing token overhead by up to 60% compared to standard LLaMA/GPT models for Hindi and regional scripts.
- **Inference Advantage**: Because only 3.3B parameters are activated per token, generation speeds reach **60–90 tokens/sec**, which is critical for sub-500ms conversational turn-around times.

---

## 2. Hardware & GPU Sizing Matrix

| Precision / Quantization         | Minimum VRAM Needed | Recommended Hardware Setup                          | Cost Tier                                      |
| :------------------------------- | :------------------ | :-------------------------------------------------- | :--------------------------------------------- |
| **BF16 / FP16 (Full Precision)** | ~64 GB VRAM         | 1x NVIDIA A100 (80GB) or 1x H100 (80GB)             | Cloud Dedicated Instance (~$2.50–$3.50/hr)     |
| **FP8 / INT8 (Near Lossless)**   | ~34 GB VRAM         | 1x NVIDIA RTX 6000 Ada (48GB) or 2x RTX 4090 (24GB) | Workstation / Mid-Tier Cloud (~$1.20–$1.80/hr) |
| **AWQ / INT4 (Quantized)**       | ~18 GB VRAM         | 1x NVIDIA RTX 4090 (24GB) or 1x NVIDIA A10G (24GB)  | Budget Single-GPU Instance (~$0.70–$1.00/hr)   |

---

## 3. Hosting with vLLM (OpenAI-Compatible Engine)

vLLM provides native continuous batching, PagedAttention, and an OpenAI-compatible HTTP server out of the box.

### 3.1 Prerequisites

- Linux OS (Ubuntu 22.04 LTS recommended)
- NVIDIA Drivers 535+ and CUDA 12.1+
- Python 3.10+
- Hugging Face account token with access to `gnani/gnani-evon-v3.3-30b-a3b`

### 3.2 Installation

```bash
# 1. Create a dedicated virtual environment
python3 -m venv venv
source venv/bin/activate

# 2. Install PyTorch with CUDA 12.1
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121

# 3. Install vLLM and huggingface_hub
pip install vllm>=0.6.3 huggingface_hub
```

### 3.3 Login to Hugging Face

```bash
huggingface-cli login --token <YOUR_HF_TOKEN>
```

### 3.4 Launching the vLLM OpenAI-Compatible Server

#### Option A: Single A100/H100 (BF16)

```bash
python3 -m vllm.entrypoints.openai.api_server \
  --model gnani/gnani-evon-v3.3-30b-a3b \
  --served-model-name evon-30b \
  --host 0.0.0.0 \
  --port 8000 \
  --dtype bfloat16 \
  --max-model-len 8192 \
  --enable-auto-tool-choice \
  --tool-call-parser openai
```

#### Option B: Single RTX 4090 or A10G (4-Bit AWQ Quantization)

```bash
python3 -m vllm.entrypoints.openai.api_server \
  --model gnani/gnani-evon-v3.3-30b-a3b \
  --served-model-name evon-30b \
  --host 0.0.0.0 \
  --port 8000 \
  --quantization awq \
  --max-model-len 4096 \
  --gpu-memory-utilization 0.92 \
  --enable-auto-tool-choice \
  --tool-call-parser openai
```

---

## 4. Docker Deployment (`docker-compose.yml`)

For production environments, containerize the vLLM server:

```yaml
version: '3.8'

services:
  evon-llm:
    image: vllm/vllm-openai:v0.6.3
    container_name: appointly-evon-llm
    restart: always
    environment:
      - HUGGING_FACE_HUB_TOKEN=${HF_TOKEN}
    ports:
      - '8000:8000'
    ipc: host
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    command: >
      --model gnani/gnani-evon-v3.3-30b-a3b
      --served-model-name evon-30b
      --host 0.0.0.0
      --port 8000
      --max-model-len 8192
      --enable-auto-tool-choice
      --tool-call-parser openai
```

Start the container:

```bash
docker compose up -d
```

---

## 5. Health Check & Verification

Test that the endpoint is ready to receive OpenAI-compatible requests:

```bash
curl http://localhost:8000/v1/models
```

Expected output:

```json
{
  "object": "list",
  "data": [
    {
      "id": "evon-30b",
      "object": "model",
      "owned_by": "vllm"
    }
  ]
}
```

Test a tool-calling chat completion:

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "evon-30b",
    "messages": [
      {"role": "user", "content": "Doctor Sharma ka appointment kab milega?"}
    ],
    "temperature": 0.2
  }'
```

---

## 6. Configuring Appointly to Use Your Evon Instance

In your Appointly `.env` file, point `EVON_BASE_URL` to your hosted vLLM endpoint:

```ini
# Live Evon 30B Instance Configuration
EVON_BASE_URL="http://localhost:8000/v1"
EVON_API_KEY="dummy-token-or-secret"
EVON_MODEL="evon-30b"
USE_MOCK_SERVICES="false"
```
