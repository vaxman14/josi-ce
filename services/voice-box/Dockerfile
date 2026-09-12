FROM python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7 AS common
LABEL org.opencontainers.image.title="Josi CE Voice Box" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
WORKDIR /app
COPY requirements.lock .
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
COPY models.lock.json download_models.py ./
RUN python download_models.py /models
COPY gateway.py settings.py health.py tts.py bounded_http.py unix_http.py ./
COPY LICENSES.md /usr/share/voice-box/LICENSES.md
ENV HF_HUB_OFFLINE=1 PYTHONDONTWRITEBYTECODE=1
USER 1000:1000
CMD ["python", "/app/gateway.py"]

# Built only with --target gpu. Selecting CUDA also requires the operator's
# catalog entry to mark this exact digest gpu:true and an installed NVIDIA
# Container Toolkit. TTS remains on CPU; only transcription uses the GPU.
FROM common AS gpu
USER root
COPY requirements-gpu.lock /app/requirements-gpu.lock
RUN pip install --no-cache-dir --require-hashes -r /app/requirements-gpu.lock
ENV LD_LIBRARY_PATH=/usr/local/lib/python3.12/site-packages/nvidia/cublas/lib:/usr/local/lib/python3.12/site-packages/nvidia/cudnn/lib
USER 1000:1000

# The default build is always CPU-first.
FROM common AS cpu
