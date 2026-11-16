"""Cut, loudness-normalize and export song excerpts for the recognition survey.

Step 1 - cut
    For each CSV row, the audio file is looked up by the value in the
    soundtrack column (e.g. "BabyMine" -> audio_dir/BabyMine.mp3), and an
    excerpt of `--duration` seconds is cut starting at Start_Timestamp
    ("m:ss"). A cell may hold several timestamps ("1:55, 2:34"); each becomes
    its own excerpt with a numbered suffix (ForTheFirstTimeInForever_1, _2).
    Short linear fades are applied at both ends so excerpts don't click.

Step 2 - loudness normalization (ITU-R BS.1770 / EBU R128)
    Each excerpt's integrated loudness (LUFS) and true peak (dBTP) are
    measured with ffmpeg's ebur128 filter, and a single gain is applied so
    every excerpt lands at the same loudness. If reaching `--target-lufs`
    would push any excerpt's true peak above `--peak-ceiling`, the common
    target is lowered for ALL excerpts so they stay equally loud without
    clipping or limiting. Written files are re-measured and logged to
    loudness_report.csv (next to this script).

Step 3 - export for the survey site
    Normalized excerpts are copied to `excerpts_8s_anonymized/` under random IDs
    (clip_3f9a1c2e.mp3) so titles can't be read from filenames, and
    clips.js is rewritten with that list. Two private files are written to
    private/ (git-ignored; never upload them):
      key.csv       clip_id, title, alternates -> import into the Sheet's Key tab
      clip_map.csv  clip_id -> excerpt name, source file, start time
    IDs are reused from an existing clip_map.csv, so re-running the script
    doesn't invalidate responses already collected.

Requires: numpy, soundfile, and ffmpeg on PATH.

Usage:
    python prepare_stimuli.py
    python prepare_stimuli.py --target-lufs -20 --peak-ceiling -1
    python prepare_stimuli.py --no-normalize --no-site
"""

import argparse
import csv
import re
import secrets
import shutil
import subprocess
import unicodedata
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]

DEFAULT_CSV = HERE / "stimuli_ballad_test_excerpts.csv"
DEFAULT_TITLES = HERE / "song_titles.csv"
DEFAULT_AUDIO_DIR = REPO / "DisneyCorpus" / "audio_full"
DEFAULT_OUT_DIR = HERE / "excerpts_8s"
DEFAULT_REPORT = HERE / "loudness_report.csv"
DEFAULT_SITE_DIR = HERE
DEFAULT_PRIVATE_DIR = HERE / "private"   # git-ignored

NAME_COL = "Soundtrack (with Youtube Link)"
START_COL = "Start_Timestamp"
AUDIO_EXTENSIONS = (".mp3", ".wav", ".flac", ".m4a", ".aiff", ".ogg")


# --------------------------------------------------------------------------
# Cutting
# --------------------------------------------------------------------------

def parse_timestamp(ts):
    """'2:10' -> 130.0, '1:02:03' -> 3723.0, '45' -> 45.0"""
    seconds = 0.0
    for part in ts.strip().split(":"):
        seconds = seconds * 60 + float(part)
    return seconds


def nfc(s):
    # macOS stores filenames decomposed (NFD); CSVs are usually NFC ("Baía").
    return unicodedata.normalize("NFC", s)


def index_audio_files(audio_dir):
    """Map normalized stem (case-insensitive) -> path."""
    return {
        nfc(p.stem).lower(): p
        for p in Path(audio_dir).iterdir()
        if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS
    }


def cut_excerpt(audio_path, start_s, duration_s, fade_ms=20.0):
    """Return (audio [frames x channels] float64, samplerate)."""
    info = sf.info(audio_path)
    sr = info.samplerate
    start = int(round(start_s * sr))
    n = int(round(duration_s * sr))

    if start + n > info.frames:
        raise ValueError(
            f"excerpt {start_s:.2f}-{start_s + duration_s:.2f}s runs past end "
            f"of file ({info.frames / sr:.2f}s)"
        )

    audio, _ = sf.read(audio_path, start=start, frames=n, always_2d=True)

    n_fade = min(int(round(fade_ms / 1000 * sr)), n // 2)
    if n_fade > 0:
        ramp = np.linspace(0.0, 1.0, n_fade)[:, None]
        audio[:n_fade] *= ramp
        audio[-n_fade:] *= ramp[::-1]
    return audio, sr


# --------------------------------------------------------------------------
# Loudness (ffmpeg ebur128: BS.1770 K-weighted, gated integrated loudness)
# --------------------------------------------------------------------------

_I_RE = re.compile(r"I:\s+(-?[\d.]+|-inf)\s+LUFS")
_TP_RE = re.compile(r"True peak:\s+Peak:\s+(-?[\d.]+|-inf)\s+dBFS")


def _parse_ebur128(stderr):
    i_vals, tp_vals = _I_RE.findall(stderr), _TP_RE.findall(stderr)
    if not i_vals or not tp_vals:
        raise RuntimeError("could not parse ffmpeg ebur128 output")
    # the summary at the end is the last match
    return float(i_vals[-1]), float(tp_vals[-1])


def measure_array(audio, sr):
    """Integrated loudness (LUFS) and true peak (dBTP) of an in-memory signal."""
    raw = np.ascontiguousarray(audio, dtype="<f4").tobytes()
    proc = subprocess.run(
        ["ffmpeg", "-nostats", "-hide_banner",
         "-f", "f32le", "-ar", str(sr), "-ac", str(audio.shape[1]), "-i", "pipe:0",
         "-af", "ebur128=peak=true", "-f", "null", "-"],
        input=raw, capture_output=True,
    )
    return _parse_ebur128(proc.stderr.decode(errors="replace"))


def measure_file(path):
    proc = subprocess.run(
        ["ffmpeg", "-nostats", "-hide_banner", "-i", str(path),
         "-af", "ebur128=peak=true", "-f", "null", "-"],
        capture_output=True,
    )
    return _parse_ebur128(proc.stderr.decode(errors="replace"))


def choose_target(measured, target_lufs, peak_ceiling):
    """Highest common loudness <= target_lufs that keeps every true peak
    under the ceiling. Returns (target, limiting_stem_or_None)."""
    target, limiter = target_lufs, None
    for stem, (lufs, tp) in measured.items():
        # gain that puts this excerpt's peak exactly at the ceiling
        max_target = lufs + (peak_ceiling - tp)
        if max_target < target:
            target, limiter = max_target, stem
    return target, limiter


# --------------------------------------------------------------------------
# Site export (anonymized audio, clips.js, private key)
# --------------------------------------------------------------------------

def load_titles(path):
    """excerpt name -> [title, alternates...]"""
    titles = {}
    if Path(path).exists():
        with open(path, newline="", encoding="utf-8-sig") as f:
            for row in csv.reader(f):
                if row and row[0] != "excerpt":
                    titles[nfc(row[0].strip())] = [c.strip() for c in row[1:] if c.strip()]
    return titles


def title_from_name(name):
    """'HowFarIllGoReprise' -> 'How Far Ill Go (Reprise)'.

    Good enough for scoring: the Sheet's matcher ignores capitals, spaces and
    apostrophes, and treats the bracketed part as optional."""
    words = re.sub(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", " ", name)
    return re.sub(r"\s+(Reprise|Prologue|Finale|Instrumental)$", r" (\1)", words)


def load_clip_map(path):
    """excerpt stem -> clip_id, from a previous run."""
    if not Path(path).exists():
        return {}
    with open(path, newline="", encoding="utf-8") as f:
        return {nfc(r["excerpt"]): r["clip_id"] for r in csv.DictReader(f)}


def export_site(written, meta, site_dir, private_dir, titles_path):
    """written: stem -> normalized file path. meta: stem -> (source, start, base)."""
    audio_dir = site_dir / "excerpts_8s_anonymized"
    audio_dir.mkdir(parents=True, exist_ok=True)
    private_dir.mkdir(parents=True, exist_ok=True)

    map_path = private_dir / "clip_map.csv"
    ids = load_clip_map(map_path)
    used = set(ids.values())
    for stem in written:
        if stem not in ids:
            cid = f"clip_{secrets.token_hex(4)}"
            while cid in used:
                cid = f"clip_{secrets.token_hex(4)}"
            ids[stem] = cid
            used.add(cid)

    # replace previously exported clips so removed excerpts don't linger
    for old in audio_dir.glob("clip_*"):
        old.unlink()
    files = []
    for stem, path in written.items():
        dest = audio_dir / f"{ids[stem]}{path.suffix}"
        shutil.copyfile(path, dest)
        files.append(dest.name)
    files.sort()

    (site_dir / "clips.js").write_text(
        "// Generated by prepare_stimuli.py. Do not edit by hand.\n"
        "window.CLIPS = [\n" + "".join(f'  "{f}",\n' for f in files) + "];\n",
        encoding="utf-8",
    )

    # song_titles.csv is optional: it only adds nicer titles and alternate
    # names. Songs not listed get a title derived from their name.
    titles = load_titles(titles_path)
    guessed = []
    with open(private_dir / "key.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["clip_id", "title", "alternate 1", "alternate 2", "alternate 3"])
        for stem in sorted(written, key=lambda s: ids[s]):
            base = meta[stem][2]
            row = titles.get(base)
            if not row:
                row = [title_from_name(base)]
                guessed.append(row[0])
            w.writerow([ids[stem]] + row)

    with open(map_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["clip_id", "excerpt", "source", "start"])
        for stem in sorted(ids, key=lambda s: ids[s]):
            src, start = meta[stem][:2] if stem in meta else ("", "")
            w.writerow([ids[stem], stem, src, start])

    print(f"\nSite: {len(files)} anonymized clips in {audio_dir}, list in {site_dir / 'clips.js'}")
    print(f"Private (do not upload): {private_dir / 'key.csv'}, {map_path}")
    if guessed:
        print(f"Titles from file names (not in {Path(titles_path).name}): {', '.join(guessed)}")


# --------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--csv", default=DEFAULT_CSV, type=Path)
    parser.add_argument("--titles", default=DEFAULT_TITLES, type=Path,
                        help="excerpt -> song title + accepted alternates")
    parser.add_argument("--audio-dir", default=DEFAULT_AUDIO_DIR, type=Path)
    parser.add_argument("-o", "--output-dir", default=DEFAULT_OUT_DIR, type=Path)
    parser.add_argument("--report", default=DEFAULT_REPORT, type=Path)
    parser.add_argument("--site-dir", default=DEFAULT_SITE_DIR, type=Path,
                        help="folder with index.html; gets excerpts_8s_anonymized/ and clips.js")
    parser.add_argument("--private-dir", default=DEFAULT_PRIVATE_DIR, type=Path,
                        help="where key.csv and clip_map.csv go (keep outside the repo)")
    parser.add_argument("--duration", default=8.0, type=float, help="seconds")
    parser.add_argument("--fade-ms", default=20.0, type=float,
                        help="fade in/out length (0 to disable)")
    parser.add_argument("--format", default="mp3", choices=["mp3", "wav", "flac"],
                        help="output format (mp3 is smallest for the web survey)")
    parser.add_argument("--target-lufs", default=-18.0, type=float,
                        help="desired loudness; lowered automatically if any "
                             "excerpt would exceed --peak-ceiling")
    parser.add_argument("--peak-ceiling", default=-1.0, type=float,
                        help="max true peak in dBTP after normalization "
                             "(-1 leaves headroom for MP3 encoding)")
    parser.add_argument("--no-normalize", action="store_true",
                        help="only cut, keep original levels")
    parser.add_argument("--no-site", action="store_true",
                        help="skip exporting excerpts_8s_anonymized/, clips.js and key.csv")
    args = parser.parse_args()

    if shutil.which("ffmpeg") is None and not args.no_normalize:
        raise SystemExit("ffmpeg not found on PATH (needed for loudness measurement)")

    # ---- 1. cut ---------------------------------------------------------
    files = index_audio_files(args.audio_dir)
    excerpts = {}           # stem -> (audio, sr)
    meta = {}               # stem -> (source file, timestamp, base name)
    missing, failed = [], []

    with open(args.csv, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            name = nfc(row[NAME_COL].strip())
            stamps = [s.strip() for s in row[START_COL].split(",") if s.strip()]
            if not name or not stamps:
                continue
            src = files.get(name.lower())
            if src is None:
                missing.append(name)
                continue
            for i, ts in enumerate(stamps, start=1):
                stem = name if len(stamps) == 1 else f"{name}_{i}"
                try:
                    excerpts[stem] = cut_excerpt(src, parse_timestamp(ts), args.duration,
                                                 fade_ms=args.fade_ms)
                    meta[stem] = (src.name, ts, name)
                except Exception as e:
                    failed.append(f"{stem}: {e}")

    print(f"Cut {len(excerpts)} excerpts of {args.duration:g} s")
    if not excerpts:
        raise SystemExit("Nothing to write.")

    # ---- 2. measure + choose a common target ----------------------------
    gains = {stem: 0.0 for stem in excerpts}
    before = {}
    if not args.no_normalize:
        for stem, (audio, sr) in excerpts.items():
            before[stem] = measure_array(audio, sr)

        silent = [s for s, (l, _) in before.items() if not np.isfinite(l)]
        if silent:
            raise SystemExit(f"Silent excerpt(s), check timestamps: {', '.join(silent)}")

        target, limiter = choose_target(before, args.target_lufs, args.peak_ceiling)
        if limiter:
            print(f"Target lowered from {args.target_lufs:g} to {target:.1f} LUFS so "
                  f"'{limiter}' stays under {args.peak_ceiling:g} dBTP")
        else:
            print(f"Target {target:.1f} LUFS")
        gains = {s: target - l for s, (l, _) in before.items()}

    # ---- 3. apply gain + write -----------------------------------------
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report, written = [], {}
    for stem, (audio, sr) in excerpts.items():
        out = args.output_dir / f"{stem}.{args.format}"
        g = gains[stem]
        sf.write(out, audio * (10 ** (g / 20)), sr)
        written[stem] = out

        if not args.no_normalize:
            l_after, tp_after = measure_file(out)
            l0, tp0 = before[stem]
            report.append({
                "excerpt": out.name, "source": meta[stem][0], "start": meta[stem][1],
                "lufs_before": f"{l0:.1f}", "true_peak_before": f"{tp0:.1f}",
                "gain_db": f"{g:+.1f}",
                "lufs_after": f"{l_after:.1f}", "true_peak_after": f"{tp_after:.1f}",
            })
            print(f"  {out.name:36s} {l0:6.1f} -> {l_after:6.1f} LUFS  "
                  f"(gain {g:+5.1f} dB, peak {tp_after:5.1f} dBTP)")
        else:
            print(f"  {out.name}")

    print(f"\n{len(written)} excerpts written to {args.output_dir}")

    if report:
        with open(args.report, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(report[0].keys()))
            w.writeheader()
            w.writerows(report)
        after = np.array([float(r["lufs_after"]) for r in report])
        peaks = np.array([float(r["true_peak_after"]) for r in report])
        print(f"Loudness after normalization: {after.min():.1f} to {after.max():.1f} LUFS "
              f"(spread {after.max() - after.min():.1f} LU), "
              f"max true peak {peaks.max():.1f} dBTP")
        print(f"Report: {args.report}")

    # ---- 4. export for the survey site ----------------------------------
    if not args.no_site:
        export_site(written, meta, args.site_dir, args.private_dir, args.titles)

    if missing:
        print(f"\nNo audio file found for {len(missing)} row(s):")
        for m in missing:
            print(f"  - {m}")
    if failed:
        print(f"\n{len(failed)} excerpt(s) failed:")
        for msg in failed:
            print(f"  - {msg}")


if __name__ == "__main__":
    main()
