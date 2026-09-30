#!/usr/bin/env python3
"""Private, authenticated Sopro synthesis for Josi's fixed Neighbor voice."""
import argparse
import hmac
import io
import json
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

import torch
from sopro import SoproTTS

MODEL = "samuel-vitorino/sopro-v2-turbo"
REVISION = "f747f9edfb7b0233a3b7105af3a75603a7213d26"


class Engine:
    def __init__(self, reference, token, cache):
        self.token = token
        self.lock = threading.Lock()
        torch.set_num_threads(4)
        torch.manual_seed(14)
        self.tts = SoproTTS.from_pretrained(MODEL, revision=REVISION, device="cpu",
                                            quantization="int8", cache_dir=cache)
        self.reference = self.tts.prepare_reference(ref_audio_path=reference, seconds=20, stream=True)
        self.speech("Neighbor voice ready.")

    def speech(self, text):
        chunks = [chunk.cpu() for chunk in self.tts.stream(text, ref=self.reference, lang="en")]
        if not chunks:
            raise ValueError("No speech generated")
        output = io.BytesIO()
        audio = torch.cat(chunks, dim=-1).squeeze().clamp(-1, 1)
        pcm = (audio * 32767).to(torch.int16).numpy().astype("<i2", copy=False).tobytes()
        with wave.open(output, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(self.tts.sample_rate)
            wav.writeframes(pcm)
        return output.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path == "/health" and self.authorized():
            self.reply(200, b'{"ready":true}', "application/json")
        else:
            self.reply(404, b'{"error":"not found"}', "application/json")

    def do_POST(self):
        if self.path != "/speech" or not self.authorized():
            self.reply(404, b'{"error":"not found"}', "application/json")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if self.headers.get("Transfer-Encoding") or not 1 <= length <= 8192:
                raise ValueError("invalid request")
            body = json.loads(self.rfile.read(length))
            text = body.get("text") if isinstance(body, dict) and set(body) == {"text"} else None
            if not isinstance(text, str) or not 1 <= len(text) <= 600:
                raise ValueError("invalid text")
            if not self.server.engine.lock.acquire(blocking=False):
                self.reply(429, b'{"error":"busy"}', "application/json")
                return
            try:
                audio = self.server.engine.speech(text)
            finally:
                self.server.engine.lock.release()
            self.reply(200, audio, "audio/wav")
        except (ValueError, json.JSONDecodeError):
            self.reply(400, b'{"error":"invalid request"}', "application/json")
        except Exception:
            self.reply(503, b'{"error":"speech failed"}', "application/json")

    def authorized(self):
        return hmac.compare_digest(self.headers.get("Authorization", ""),
                                   "Bearer " + self.server.engine.token)

    def reply(self, status, data, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=3911)
    parser.add_argument("--reference", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--cache", required=True)
    args = parser.parse_args()
    token = Path(args.token_file).read_text().strip()
    if len(token) < 32:
        raise ValueError("Missing service credential")
    server = ThreadingHTTPServer((args.bind, args.port), Handler)
    server.engine = Engine(args.reference, token, args.cache)
    server.serve_forever()
