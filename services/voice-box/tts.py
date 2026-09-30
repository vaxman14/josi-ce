"""Local neural synthesis with pinned Kokoro and Kitten ONNX models."""
import io
import json
import re
from pathlib import Path
import wave
import numpy as np


class NeuralSpeech:
    def __init__(self, config, root='/models'):
        self.config = config
        root = Path(root)
        import onnxruntime as ort
        if config['voice'].startswith('kitten_'):
            self._init_kitten(root, ort)
            return
        from misaki import en
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        self.model = ort.InferenceSession(str(root / 'kokoro/model.onnx'), options,
                                          providers=['CPUExecutionProvider'])
        # Pin the English tagger in the runtime lock; never download at use.
        import spacy
        if not spacy.util.is_package('en_core_web_sm'):
            raise ValueError('The pinned English pronunciation model is missing')
        speller = en.G2P(trf=False, british=False, fallback=None)
        self.g2p = en.G2P(trf=False, british=False,
                         fallback=lambda token: (speller(' '.join(token.text.upper()))[0], 1))
        self.vocab = json.loads((root / 'kokoro/config.json').read_text())['vocab']
        self.voice = np.fromfile(root / ('kokoro/' + config['voice'] + '.bin'), dtype='<f4').reshape(-1, 1, 256)

    def _init_kitten(self, root, ort):
        from misaki import en
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        base = root / 'kitten-nano'
        self.model = ort.InferenceSession(str(base / 'model.onnx'), options,
                                          providers=['CPUExecutionProvider'])
        speller = en.G2P(trf=False, british=False, fallback=None)
        self.kitten_g2p = en.G2P(trf=False, british=False,
                                 fallback=lambda token: (speller(' '.join(token.text.upper()))[0], 1))
        self.voices = np.load(base / 'voices.npz')
        metadata = json.loads((base / 'config.json').read_text())
        alias = self.config['voice'].removeprefix('kitten_').capitalize()
        self.voice_key = metadata['voice_aliases'][alias]
        self.speed_prior = metadata['speed_priors'][self.voice_key]

    @staticmethod
    def _kitten_tokens(text):
        punctuation = ';:,.!?¡¿—…“”«»" '
        letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
        ipa = "ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘'̩'ᵻ"
        vocabulary = {symbol: index for index, symbol in enumerate(['$', *punctuation, *letters, *ipa])}
        phonemes = ' '.join(re.findall(r"\w+|[^\w\s]", text))
        return [vocabulary[c] for c in phonemes if c in vocabulary]

    def speech(self, text):
        if self.config['voice'].startswith('kitten_'):
            return self._kitten_speech(text)
        output = io.BytesIO()
        phonemes, _ = self.g2p(re.sub(r'\bJosi\b', '[Josi](/ˈʤoʊzi/)', text, flags=re.IGNORECASE))
        tokens = [self.vocab[p] for p in phonemes if p in self.vocab]
        if not tokens:
            raise ValueError('No pronounceable text')
        parts = []
        # Kokoro permits at most 510 content tokens. Shorter windows keep speech
        # responsive and avoid the model's tendency to rush long passages.
        for start in range(0, len(tokens), 240):
            window = tokens[start:start + 240]
            result = self.model.run(None, {
                'input_ids': np.array([[0, *window, 0]], dtype=np.int64),
                'style': self.voice[len(window)],
                'speed': np.array([self.config['speed']], dtype=np.float32),
            })[0]
            parts.append(np.asarray(result).reshape(-1))
        pcm = (np.clip(np.concatenate(parts), -1, 1) * 32767).astype('<i2').tobytes()
        with wave.open(output, 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(24000)
            wav.writeframes(pcm)
        return output.getvalue()

    def _kitten_speech(self, text):
        output = io.BytesIO()
        spoken = re.sub(r'\bJosi\b', 'Joe-zee', text, flags=re.IGNORECASE)
        phonemes, _ = self.kitten_g2p(spoken)
        tokens = self._kitten_tokens(phonemes)
        if not tokens:
            raise ValueError('No pronounceable text')
        tokens = [0, *tokens, 10, 0]
        style_index = min(len(spoken), self.voices[self.voice_key].shape[0] - 1)
        result = self.model.run(None, {
            'input_ids': np.array([tokens], dtype=np.int64),
            'style': self.voices[self.voice_key][style_index:style_index + 1],
            'speed': np.array([self.config['speed'] * self.speed_prior], dtype=np.float32),
        })[0]
        audio = np.asarray(result).reshape(-1)
        if len(audio) > 5000:
            audio = audio[:-5000]
        pcm = (np.clip(audio, -1, 1) * 32767).astype('<i2').tobytes()
        with wave.open(output, 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(24000)
            wav.writeframes(pcm)
        return output.getvalue()
