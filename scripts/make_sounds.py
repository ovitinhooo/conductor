"""Generates the progress mod's two notification sounds.

The mod plays a short chime when a track needs the user's input and another
when a track is done. Both are synthesized here from plain sine tones, so no
third-party audio is copied and the files can be rebuilt at any time. The output
is deterministic: the same code always writes the same bytes, and
`tests/test_make_sounds.py` checks that the committed files match a fresh render.

Usage:
  python3 scripts/make_sounds.py [--out sounds]

Writes `needs_input.wav` (a gentle rising pair of notes, a question) and
`done.wav` (three notes that settle downwards, an answer) into the output
directory, relative to the current directory. Both are mono, 16-bit PCM at
22050 Hz, well under 1.2 s, and quiet (peak 0.35 of full scale).
"""

import argparse
import io
import math
import os
import struct
import sys
import wave

SAMPLE_RATE = 22050
# The loudest sample, as a fraction of full scale. Chimes stay soft.
PEAK = 0.35
# Linear fades on the whole sound, so it starts and ends without a click.
FADE_IN_S = 0.01
FADE_OUT_S = 0.05
# Each note rings out with this decay (seconds for the level to fall by e).
DECAY_S = 0.18
# Each note's last stretch fades to zero, so cutting the ring leaves no click.
RELEASE_S = 0.12
# Partials of one note: (frequency multiple, relative level). A soft second
# partial makes the tone chime-like instead of a bare sine.
PARTIALS = ((1.0, 1.0), (2.0, 0.25), (3.0, 0.08))
# Notes in Hz.
C5, E5, G5, A5 = 523.25, 659.25, 783.99, 880.00
# name -> (note start in seconds, frequency in Hz, length in seconds) and the
# total length of the sound. Late notes start over the ring of the earlier ones.
SOUNDS = {
    "needs_input": {
        "notes": ((0.00, E5, 0.40), (0.16, A5, 0.50)),
        "length": 0.70,
    },
    "done": {
        "notes": ((0.00, G5, 0.40), (0.18, E5, 0.45), (0.36, C5, 0.60)),
        "length": 1.00,
    },
}
NAMES = tuple(SOUNDS)


def _note(freq, length):
  """Returns one note's samples: partials under a decaying envelope."""
  count = int(length * SAMPLE_RATE)
  release = int(RELEASE_S * SAMPLE_RATE)
  out = []
  for i in range(count):
    t = i / SAMPLE_RATE
    level = sum(
        amp * math.sin(2 * math.pi * freq * mult * t) for mult, amp in PARTIALS
    )
    level *= math.exp(-t / DECAY_S)
    if i >= count - release:
      # The ring is cut here, so close it smoothly.
      level *= (count - 1 - i) / release
    out.append(level)
  return out


def _mix(spec):
  """Returns the sound's samples as floats in [-PEAK, PEAK], faded."""
  total = int(spec["length"] * SAMPLE_RATE)
  mixed = [0.0] * total
  for start, freq, length in spec["notes"]:
    offset = int(start * SAMPLE_RATE)
    for i, value in enumerate(_note(freq, length)):
      if offset + i < total:
        mixed[offset + i] += value
  peak = max(abs(v) for v in mixed)
  fade_in = int(FADE_IN_S * SAMPLE_RATE)
  fade_out = int(FADE_OUT_S * SAMPLE_RATE)
  scale = PEAK / peak
  for i, value in enumerate(mixed):
    gain = scale
    if i < fade_in:
      gain *= i / fade_in
    if i >= total - fade_out:
      gain *= (total - 1 - i) / fade_out
    mixed[i] = value * gain
  return mixed


def render(name):
  """Returns the named sound as the bytes of a mono 16-bit WAV file.

  Args:
    name: one of NAMES.

  Raises:
    ValueError: if the name is not a known sound.
  """
  if name not in SOUNDS:
    raise ValueError(f"unknown sound {name!r}; expected one of {NAMES}")
  samples = [round(v * 32767) for v in _mix(SOUNDS[name])]
  buffer = io.BytesIO()
  with wave.open(buffer, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SAMPLE_RATE)
    w.writeframes(struct.pack(f"<{len(samples)}h", *samples))
  return buffer.getvalue()


def build_parser():
  """Returns the command-line parser."""
  parser = argparse.ArgumentParser(
      description="Generate the Conductor progress mod's notification sounds."
  )
  parser.add_argument(
      "--out", default="sounds",
      help="Directory to write the .wav files into (default: sounds).",
  )
  return parser


def main(argv=None):
  """Writes every sound into the output directory and returns the exit code."""
  args = build_parser().parse_args(argv)
  os.makedirs(args.out, exist_ok=True)
  for name in NAMES:
    path = os.path.join(args.out, name + ".wav")
    with open(path, "wb") as f:
      f.write(render(name))
    print(path)
  return 0


if __name__ == "__main__":
  sys.exit(main())
