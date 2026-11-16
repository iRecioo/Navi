import argparse
import hmac
import io
import json
import os
import re
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import onnxruntime as ort
from piper.config import PiperConfig, SynthesisConfig
from piper.voice import PiperVoice


def spoken_text(text):
    text = re.sub(r'\[([^\]\n]+)\]\(https?://[^\s)]+\)', r'\1', text)
    text = text.translate(str.maketrans({'«': '', '»': '', '“': '', '”': '', '„': '',
                                       '—': ', ', '…': '...', '*': '', '`': ''}))
    return ' '.join(text.split())


def main():
    ort.disable_telemetry_events()
    parser = argparse.ArgumentParser()
    parser.add_argument('model', type=Path)
    parser.add_argument('config', type=Path)
    args = parser.parse_args()
    token = os.environ['NAVI_TTS_TOKEN']

    options = ort.SessionOptions()
    options.intra_op_num_threads = min(os.cpu_count() or 1, 4)
    options.inter_op_num_threads = 1
    options.add_session_config_entry('session.intra_op.allow_spinning', '0')
    model = ort.InferenceSession(str(args.model), sess_options=options, providers=['CPUExecutionProvider'])
    voice = PiperVoice(model, PiperConfig.from_dict(json.loads(args.config.read_text(encoding='utf-8'))))
    settings = SynthesisConfig(speaker_id=1, length_scale=.94, noise_scale=.50, noise_w_scale=.58)
    voice.phonemize('Cinco zapatos.')
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
                size = int(self.headers.get('Content-Length', 0))
                payload = json.loads(self.rfile.read(size)) if 0 < size <= 16_384 else {}
                text = payload.get('input')
                if not isinstance(text, str) or not text.strip() or len(text) > 2000:
                    raise ValueError()
            except (AttributeError, ValueError):
                self.send_error(400)
                return

            output = io.BytesIO()
            try:
                with lock, wave.open(output, 'wb') as wav:
                    voice.synthesize_wav(spoken_text(text), wav, settings)
            except Exception as error:
                print(str(error), file=sys.stderr, flush=True)
                self.send_error(500)
                return

            audio = output.getbuffer()
            if not 44 < len(audio) <= 12_000_000:
                self.send_error(500)
                return
            self.send_response(200)
            self.send_header('Content-Type', 'audio/wav')
            self.send_header('Content-Length', str(len(audio)))
            self.end_headers()
            try:
                self.wfile.write(audio)
            except ConnectionError:
                pass

    with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
        print(f'NAVI_TTS_PORT={server.server_port}', flush=True)
        server.serve_forever()


if __name__ == '__main__':
    main()
