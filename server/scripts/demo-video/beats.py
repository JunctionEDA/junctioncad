"""Beats of a soundtrack, for render.mjs to cut on: python3 beats.py music.wav out.json

Writes {duration, tempo, beats: [s...], strong: [s...], last_hit: s}: every beat librosa finds, the beats with the
strongest onsets (the accents a cut should land on), and the last loud hit (the closing chord, for the end card).
"""
import json
import sys

import librosa
import numpy as np

src, dst = sys.argv[1], sys.argv[2]
y, sr = librosa.load(src, sr=22050, mono=True)
dur = len(y) / sr
env = librosa.onset.onset_strength(y=y, sr=sr)
tempo, frames = librosa.beat.beat_track(onset_envelope=env, sr=sr, trim=False)
beats = librosa.frames_to_time(frames, sr=sr)
power = env[frames] if len(frames) else np.array([])
cut = np.percentile(power, 70) if len(power) else 0
strong = [float(t) for t, p in zip(beats, power) if p >= cut]
# the closing chord: the last onset louder than most of the piece
rms = librosa.feature.rms(y=y)[0]
times = librosa.frames_to_time(np.arange(len(rms)), sr=sr)
loud = np.where(rms > np.percentile(rms, 90))[0]
onsets = librosa.onset.onset_detect(onset_envelope=env, sr=sr, units="time")
last_hit = float(max([t for t in onsets if loud.size and t <= times[loud[-1]] + 0.05] or [times[loud[-1]] if loud.size else dur]))
json.dump({"duration": round(dur, 3), "tempo": float(np.atleast_1d(tempo)[0]), "beats": [round(float(t), 3) for t in beats],
           "strong": [round(t, 3) for t in strong], "last_hit": round(last_hit, 3)}, open(dst, "w"))
print(src, f"{dur:.1f}s", f"tempo {float(np.atleast_1d(tempo)[0]):.1f}", len(beats), "beats", len(strong), "strong", f"last hit {last_hit:.2f}s")
