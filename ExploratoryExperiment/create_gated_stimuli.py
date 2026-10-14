"""Create gated stimuli (gating paradigm) from a directory of audio files.

Each gate is the first N ms of the source audio. All gates are written into
a single output folder, with the gate in the filename, e.g.:

    song_100ms.wav
    song_250ms.wav
    ...

Usage:
    python create_gated_stimuli.py path/to/songs_dir [-o output_folder] [--ramp-ms 5]
"""

import argparse
from pathlib import Path

import numpy as np
import soundfile as sf

GATE_DURATIONS_MS = [250, 500, 1000, 2000, 4000, 8000]
AUDIO_EXTENSIONS = {".wav", ".flac", ".aiff", ".aif", ".ogg", ".mp3"}


def create_gated_stimuli(
    audio_path,
    output_dir=".",
    gate_durations_ms=GATE_DURATIONS_MS,
    ramp_ms=0.0,
):
    """Slice `audio_path` into onset-aligned gates of the given durations.

    Each gate keeps audio from 0 to the gate duration. A short linear
    fade-out (`ramp_ms`) is applied at the cut point to avoid an audible
    click; set `ramp_ms=0` to disable it. Gates longer than the file are
    skipped with a warning.

    Returns a list of paths to the written files.
    """
    audio_path = Path(audio_path)
    output_dir = Path(output_dir)

    audio, sr = sf.read(audio_path, always_2d=True)
    total_ms = len(audio) / sr * 1000
    info = sf.info(audio_path)

    output_dir.mkdir(parents=True, exist_ok=True)

    written = []
    for gate_ms in gate_durations_ms:
        if gate_ms > total_ms:
            print(f"Skipping {gate_ms} ms gate: file is only {total_ms:.1f} ms long")
            continue

        n_samples = int(round(gate_ms / 1000 * sr))
        gate = audio[:n_samples].copy()

        n_ramp = min(int(round(ramp_ms / 1000 * sr)), n_samples)
        if n_ramp > 0:
            gate[-n_ramp:] *= np.linspace(1.0, 0.0, n_ramp)[:, None]

        out_path = output_dir / f"{audio_path.stem}_{gate_ms}ms{audio_path.suffix}"
        sf.write(out_path, gate, sr, subtype=info.subtype)
        written.append(out_path)

    return written


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("input_dir", help="Directory of audio files (wav, mp3, flac, ...)")
    parser.add_argument("-o", "--output-dir", default=".")
    parser.add_argument("--ramp-ms", type=float, default=0.0,
                        help="Fade-out length at each gate offset (0 to disable)")
    args = parser.parse_args()

    audio_files = sorted(
        p for p in Path(args.input_dir).iterdir()
        if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS
    )
    if not audio_files:
        raise SystemExit(f"No audio files found in {args.input_dir}")

    for audio_path in audio_files:
        print(f"Gating {audio_path.name}")
        for path in create_gated_stimuli(audio_path, args.output_dir, ramp_ms=args.ramp_ms):
            print(f"  {path}")
