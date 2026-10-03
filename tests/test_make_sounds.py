"""Tests for scripts/make_sounds.py."""

import importlib.util
import contextlib
import io
import os
import shutil
import tempfile
import unittest
import wave

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "make_sounds", os.path.join(_REPO, "scripts", "make_sounds.py")
)
make_sounds = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(make_sounds)

NAMES = ("needs_input", "done")
FULL_SCALE = 32768
MAX_PEAK = 0.4
MAX_SECONDS = 1.2
MIN_SECONDS = 0.2
# The first and last samples must sit this close to silence (no click).
EDGE_LIMIT = 0.01
# The largest allowed step between neighbouring samples, as a fraction of full scale.
MAX_STEP = 0.2


def read_wav(data):
  """Returns (channels, sample width, rate, samples) of WAV bytes."""
  with wave.open(io.BytesIO(data), "rb") as w:
    frames = w.readframes(w.getnframes())
    samples = [
        int.from_bytes(frames[i:i + 2], "little", signed=True)
        for i in range(0, len(frames), 2)
    ]
    return w.getnchannels(), w.getsampwidth(), w.getframerate(), samples


class RenderTest(unittest.TestCase):

  def test_names(self):
    self.assertEqual(tuple(make_sounds.NAMES), NAMES)

  def test_valid_riff_wave(self):
    for name in NAMES:
      with self.subTest(name=name):
        data = make_sounds.render(name)
        self.assertEqual(data[:4], b"RIFF")
        self.assertEqual(data[8:12], b"WAVE")
        channels, width, rate, samples = read_wav(data)
        self.assertEqual(channels, 1)
        self.assertEqual(width, 2)
        self.assertIn(rate, (22050, 44100))
        self.assertGreater(len(samples), 0)

  def test_duration_is_short(self):
    for name in NAMES:
      with self.subTest(name=name):
        _, _, rate, samples = read_wav(make_sounds.render(name))
        seconds = len(samples) / rate
        self.assertGreaterEqual(seconds, MIN_SECONDS)
        self.assertLessEqual(seconds, MAX_SECONDS)

  def test_peak_is_well_below_full_scale(self):
    for name in NAMES:
      with self.subTest(name=name):
        _, _, _, samples = read_wav(make_sounds.render(name))
        peak = max(abs(s) for s in samples) / FULL_SCALE
        self.assertLessEqual(peak, MAX_PEAK)
        self.assertGreater(peak, 0.05, "the sound must be audible")

  def test_fades_start_and_end_near_zero(self):
    for name in NAMES:
      with self.subTest(name=name):
        _, _, _, samples = read_wav(make_sounds.render(name))
        self.assertLessEqual(abs(samples[0]) / FULL_SCALE, EDGE_LIMIT)
        self.assertLessEqual(abs(samples[-1]) / FULL_SCALE, EDGE_LIMIT)

  def test_no_sudden_jumps(self):
    # A click is a jump between neighbouring samples far beyond what the
    # tones' own slope allows (about 0.13 of full scale at the highest pitch).
    for name in NAMES:
      with self.subTest(name=name):
        _, _, _, samples = read_wav(make_sounds.render(name))
        step = max(abs(b - a) for a, b in zip(samples, samples[1:]))
        self.assertLessEqual(step / FULL_SCALE, MAX_STEP)

  def test_sounds_differ(self):
    needs_input = make_sounds.render("needs_input")
    done = make_sounds.render("done")
    self.assertNotEqual(needs_input, done)

  def test_render_is_deterministic(self):
    for name in NAMES:
      with self.subTest(name=name):
        self.assertEqual(make_sounds.render(name), make_sounds.render(name))

  def test_unknown_name_is_rejected(self):
    with self.assertRaises(ValueError):
      make_sounds.render("nope")


class CliTest(unittest.TestCase):

  def setUp(self):
    self.out = tempfile.mkdtemp()
    self.addCleanup(shutil.rmtree, self.out)

  def run_main(self, out):
    with contextlib.redirect_stdout(io.StringIO()):
      return make_sounds.main(["--out", out])

  def test_main_writes_both_files(self):
    target = os.path.join(self.out, "sounds")
    self.assertEqual(self.run_main(target), 0)
    for name in NAMES:
      path = os.path.join(target, name + ".wav")
      self.assertTrue(os.path.isfile(path), path)
      with open(path, "rb") as f:
        self.assertEqual(f.read(), make_sounds.render(name))

  def test_main_twice_gives_identical_bytes(self):
    first = os.path.join(self.out, "a")
    second = os.path.join(self.out, "b")
    self.run_main(first)
    self.run_main(second)
    for name in NAMES:
      with open(os.path.join(first, name + ".wav"), "rb") as f1:
        with open(os.path.join(second, name + ".wav"), "rb") as f2:
          self.assertEqual(f1.read(), f2.read())


# The samples come from math.sin, whose last bit can differ between platforms
# and libm versions; after rounding to 16 bits a sample may then be off by one
# step. A byte-for-byte comparison with the committed file could fail on a CI
# runner for that reason alone, so the drift check compares the headers and the
# length exactly and the samples within this many steps. A real change to the
# tones moves samples by far more. The same-run determinism tests stay exact.
SAMPLE_TOLERANCE = 2
HEADER_BYTES = 44


class CommittedSoundsTest(unittest.TestCase):

  def test_committed_files_match_a_fresh_render(self):
    for name in NAMES:
      with self.subTest(name=name):
        path = os.path.join(_REPO, "sounds", name + ".wav")
        self.assertTrue(os.path.isfile(path), "run scripts/make_sounds.py")
        with open(path, "rb") as f:
          committed = f.read()
        fresh = make_sounds.render(name)
        self.assertEqual(committed[:HEADER_BYTES], fresh[:HEADER_BYTES])
        self.assertEqual(len(committed), len(fresh))
        committed_format = read_wav(committed)[:3]
        self.assertEqual(committed_format, read_wav(fresh)[:3])
        worst = max(abs(a - b) for a, b in zip(read_wav(committed)[3],
                                               read_wav(fresh)[3]))
        self.assertLessEqual(
            worst, SAMPLE_TOLERANCE,
            "run scripts/make_sounds.py: the sounds drifted from the script")


if __name__ == "__main__":
  unittest.main()
