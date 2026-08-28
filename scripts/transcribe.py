#!/usr/bin/env python3
"""Transcribe one Govorun WhatsApp voice attachment with local faster-whisper."""
import json
import os
import sys
import time


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: transcribe.py AUDIO", file=sys.stderr)
        return 64
    try:
        from faster_whisper import WhisperModel
    except Exception as error:
        print(f"faster-whisper unavailable: {error}", file=sys.stderr)
        return 2
    started = time.time()
    try:
        model = WhisperModel(os.environ.get("WHISPER_MODEL", "base"), device="cpu", compute_type="int8")
        segments, info = model.transcribe(sys.argv[1], beam_size=1, vad_filter=True)
        text = " ".join(segment.text.strip() for segment in segments).strip()
    except Exception as error:
        print(f"transcription failed: {error}", file=sys.stderr)
        return 3
    print(json.dumps({"text": text, "language": info.language, "duration": info.duration,
                      "modelLoadMs": int((time.time() - started) * 1000)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
