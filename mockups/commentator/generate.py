#!/usr/bin/env python3
"""
Commentator TTS mockups — synthesize the sample game in mockups/commentator/
script.json with several Amazon Polly engines, one clip per log entry (the way
the replay viewer's 'entry' hook would speak them), time each call, and stitch
the clips into one track per approach.

Usage:
    python3 mockups/commentator/generate.py <out-dir>

Needs the AWS CLI's credentials (boto3 if installed, else the `aws` CLI) and
ffmpeg. Writes <out-dir>/<approach>.mp3 plus <out-dir>/timings.json.
"""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = json.loads((HERE / 'script.json').read_text())
REGION = os.environ.get('AWS_REGION', 'us-east-1')
GAP_MS = 450          # silence between clips, roughly play-after-play's papHoldMs

# Each approach: which text to read, which engine/voice, and how to mark it up.
APPROACHES = {
    'a-verbatim-generative': {
        'title': 'Verbatim log, generative voice',
        'engine': 'generative', 'voice': 'Matthew', 'text': 'raw', 'ssml': False,
    },
    'b-commentator-generative': {
        'title': 'Commentator rewrite, generative voice',
        'engine': 'generative', 'voice': 'Stephen', 'text': 'say', 'ssml': False,
    },
    'c-commentator-neural-ssml': {
        'title': 'Commentator rewrite, neural voice with SSML emphasis',
        'engine': 'neural', 'voice': 'Matthew', 'text': 'say', 'ssml': True,
    },
    'd-commentator-longform': {
        'title': 'Commentator rewrite, long-form voice',
        'engine': 'long-form', 'voice': 'Ruth', 'text': 'say', 'ssml': False,
    },
}


def clean_raw(text):
    """Make a raw log line speakable: drop delimiter dashes, parenthetical
    pull quality reads as a clause, trailing whitespace goes."""
    t = text.strip().strip('—').strip()
    t = t.replace('(Good Pull)', ', good pull').replace('(', ', ').replace(')', '')
    t = t.replace(' vs. ', ' versus ')
    return t


def ssml_for(entry, text):
    esc = (text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))
    esc = esc.replace('...', '<break time="350ms"/>')
    if entry.get('excite'):
        return f'<speak><prosody rate="112%" volume="loud">{esc}</prosody></speak>'
    return f'<speak><amazon:domain name="news">{esc}</amazon:domain></speak>'


def synthesize(engine, voice, text, ssml, out_path):
    t0 = time.perf_counter()
    try:
        import boto3  # noqa
        client = _polly()
        resp = client.synthesize_speech(Engine=engine, VoiceId=voice, OutputFormat='mp3',
                                        TextType='ssml' if ssml else 'text', Text=text)
        data = resp['AudioStream'].read()
        Path(out_path).write_bytes(data)
    except ImportError:
        subprocess.run(['aws', 'polly', 'synthesize-speech', '--region', REGION,
                        '--engine', engine, '--voice-id', voice, '--output-format', 'mp3',
                        '--text-type', 'ssml' if ssml else 'text', '--text', text, str(out_path)],
                       check=True, capture_output=True)
    return time.perf_counter() - t0


_client = None
def _polly():
    global _client
    if _client is None:
        import boto3
        _client = boto3.client('polly', region_name=REGION)
    return _client


def duration_s(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                          '-of', 'csv=p=0', str(path)], capture_output=True, text=True)
    return float(out.stdout.strip() or 0)


def stitch(clips, out_path):
    """Concatenate mp3 clips with a short silence between them."""
    with tempfile.TemporaryDirectory() as td:
        silence = Path(td) / 'gap.mp3'
        subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono',
                        '-t', str(GAP_MS / 1000), '-q:a', '9', str(silence)], check=True)
        lst = Path(td) / 'list.txt'
        lines = []
        for c in clips:
            lines.append(f"file '{c}'")
            lines.append(f"file '{silence}'")
        lst.write_text('\n'.join(lines) + '\n')
        subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', str(lst),
                        '-c:a', 'libmp3lame', '-q:a', '4', str(out_path)], check=True)


def main(out_dir):
    out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    clips_dir = out / 'clips'; clips_dir.mkdir(exist_ok=True)
    report = {'gapMs': GAP_MS, 'approaches': {}}
    for key, a in APPROACHES.items():
        clips, lat, chars, lines = [], [], 0, []
        for i, e in enumerate(SCRIPT['entries']):
            text = clean_raw(e['raw']) if a['text'] == 'raw' else e['say']
            if not text.strip():
                continue
            body = ssml_for(e, text) if a['ssml'] else text
            clip = clips_dir / f'{key}-{i:02d}.mp3'
            secs = synthesize(a['engine'], a['voice'], body, a['ssml'], clip)
            lat.append(secs); chars += len(text); clips.append(clip)
            lines.append({'index': i, 'kind': e['kind'], 'text': text, 'latencyMs': round(secs * 1000),
                          'audioS': round(duration_s(clip), 2)})
            print(f'{key} {i:02d} {secs*1000:6.0f} ms  {text[:60]}', file=sys.stderr)
        track = out / f'{key}.mp3'
        stitch(clips, track)
        lat_sorted = sorted(lat)
        report['approaches'][key] = {
            'title': a['title'], 'engine': a['engine'], 'voice': a['voice'], 'ssml': a['ssml'],
            'textSource': a['text'], 'clips': len(clips), 'characters': chars,
            'latencyMs': {'median': round(lat_sorted[len(lat)//2] * 1000),
                          'p90': round(lat_sorted[int(len(lat) * .9)] * 1000),
                          'max': round(lat_sorted[-1] * 1000)},
            'trackS': round(duration_s(track), 1), 'lines': lines,
        }
    (out / 'timings.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({k: {kk: vv for kk, vv in v.items() if kk != 'lines'} for k, v in report['approaches'].items()}, indent=2))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else HERE / 'out')
