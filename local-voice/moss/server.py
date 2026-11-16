import argparse
import hmac
import json
import os
import re
import struct
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import onnxruntime as ort
import sentencepiece as spm
from ort_cpu_runtime import OrtCpuRuntime

SAMPLE_RATE = 24000
CODEC_FRAME_LIMIT = 700


def reference_samples(path, sample_rate, channels):
    with wave.open(str(path), 'rb') as wav:
        width = wav.getsampwidth()
        rate = wav.getframerate()
        channel_count = wav.getnchannels()
        data = wav.readframes(rate * 15)
    if width == 3:
        triples = np.frombuffer(data, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        values = (triples[:, 0] | (triples[:, 1] << 8) | (triples[:, 2] << 16))
        samples = ((values ^ 0x800000) - 0x800000) / 8388608
    elif width == 1:
        samples = (np.frombuffer(data, dtype=np.uint8).astype(np.float32) - 128) / 128
    else:
        samples = np.frombuffer(data, dtype={2: '<i2', 4: '<i4'}[width]) / (1 << (width * 8 - 1))
    mono = samples.reshape(-1, channel_count).mean(axis=1)
    if len(mono) < rate:
        raise ValueError('La referencia WAV debe tener al menos un segundo de audio.')
    if rate != sample_rate:
        mono = np.interp(np.arange(round(len(mono) * sample_rate / rate)) * rate / sample_rate,
                         np.arange(len(mono)), mono)
    return np.repeat(mono.astype(np.float32)[None, None, :], channels, axis=1)


class Speech:
    def __init__(self, models, reference):
        threads = min(4, os.cpu_count() or 1)
        self.model = OrtCpuRuntime(models, thread_count=threads)
        self.tokens = spm.SentencePieceProcessor(model_file=str(self.model.manifest_dir / 'tokenizer.model'))
        codec = self.model.codec_meta['codec_config']
        if codec['sample_rate'] != 2 * SAMPLE_RATE:
            raise ValueError('Frecuencia del códec inesperada.')
        samples = reference_samples(reference, codec['sample_rate'], codec['channels'])
        encoder = self.model.sessions['codec_encode']
        encoded = encoder.run(['audio_codes', 'audio_code_lengths'], {
            'waveform': samples,
            'input_lengths': np.array([samples.shape[-1]], dtype=np.int32)
        })
        self.prompt = encoded[0][0, :int(encoded[1].flat[0])].tolist()

    def phrases(self, text):
        # Keep complete sentences together until reaching the model's recommended input size.
        text = ' '.join(text.split())
        sentences = re.split(r'(?<=[.!?…]) +', text)
        current = ''
        for sentence in sentences:
            candidate = (current + ' ' + sentence).strip()
            if len(self.tokens.encode(candidate)) <= 75:
                current = candidate
                continue
            if current:
                yield current
            current = sentence
            while len(self.tokens.encode(current)) > 75:
                words = current.split(' ')
                limit = 1
                while limit < len(words) and len(self.tokens.encode(' '.join(words[:limit + 1]))) <= 75:
                    limit += 1
                if limit == 1 and len(self.tokens.encode(words[0])) > 75:
                    yield words[0][:70]
                    current = current[70:].lstrip()
                else:
                    yield ' '.join(words[:limit])
                    current = ' '.join(words[limit:])
        if current:
            yield current

    def generate(self, text, send):
        self.model.rng = np.random.default_rng(1234)
        decoder = self.model.codec_streaming_session
        total_frames = 0
        for phrase in self.phrases(text):
            decoder.reset()
            pending = []
            parts = 0

            def flush():
                nonlocal parts
                decoded = decoder.run_frames(pending)
                pending.clear()
                if decoded is not None and decoded[1] > 0:
                    audio, length = decoded
                    mono = audio[0, :, :length].mean(axis=0)
                    if mono.size % 2:
                        mono = np.pad(mono, (0, 1))
                    mono = mono.reshape(-1, 2).mean(axis=1)
                    send((np.clip(mono, -1, 1) * 32767).astype('<i2').tobytes())
                    parts += 1

            def on_frame(_frames, _index, frame):
                pending.append(frame)
                if len(pending) >= (16 if parts else 8):
                    flush()

            tokens = self.tokens.encode(phrase)
            budget = min(375, CODEC_FRAME_LIMIT - total_frames)
            if budget <= 0:
                raise ValueError('Se alcanzó el límite de duración de la voz.')
            self.model.manifest['generation_defaults']['max_new_frames'] = budget
            rows = self.model.build_voice_clone_request_rows(self.prompt, tokens)
            frames = self.model.generate_audio_frames(rows, on_frame=on_frame)
            if pending:
                flush()
            if not parts or len(frames) == budget:
                raise ValueError('El modelo no terminó de pronunciar la respuesta.')
            total_frames += len(frames)


def main():
    ort.disable_telemetry_events()
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--reference', type=Path, required=True)
    args = parser.parse_args()
    token = os.environ['NAVI_TTS_TOKEN']
    speech = Speech(args.model, args.reference)
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                self.send_error(401)
                return
            if self.path != '/v1/audio/speech':
                self.send_error(404)
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                text = json.loads(self.rfile.read(size)).get('input', '') if 0 < size <= 16384 else ''
                if not isinstance(text, str) or not text.strip() or len(text) > 2000:
                    raise ValueError()
            except (AttributeError, ValueError):
                self.send_error(400)
                return
            with lock:
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Connection', 'close')
                self.end_headers()

                def send(data):
                    self.wfile.write(struct.pack('<I', len(data)))
                    if data:
                        self.wfile.write(data)

                try:
                    speech.generate(text, send)
                    send(b'')
                except (ConnectionError, TimeoutError):
                    pass
                except Exception as error:
                    print(str(error), file=sys.stderr, flush=True)

    with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
        print(f'NAVI_TTS_PORT={server.server_port}', flush=True)
        server.serve_forever()


if __name__ == '__main__':
    main()
