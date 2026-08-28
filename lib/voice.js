import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export async function transcribeVoice(audio) {
  const directory = await mkdtemp(join(tmpdir(), "govorun-voice-"));
  try {
    const input = join(directory, "incoming.ogg");
    await writeFile(input, audio, { mode: 0o600 });
    const python = process.env.GOVORUN_WHISPER_PYTHON || "/opt/govorun/venv/bin/python";
    const script = process.env.GOVORUN_TRANSCRIBE_SCRIPT || "/opt/govorun/app/scripts/transcribe.py";
    const { stdout } = await execFileAsync(python, [script, input], {
      timeout: 180_000,
      maxBuffer: 1_000_000,
      env: { PATH: "/usr/bin:/bin", HOME: "/home/govorun", WHISPER_MODEL: "base" },
    });
    const result = JSON.parse(stdout);
    if (!result || typeof result.text !== "string" || !result.text.trim()) throw new Error("voice note had no intelligible speech");
    return result.text.trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function speakAsWhatsappVoice(text) {
  const response = await fetch("http://127.0.0.1:8181/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: text.slice(0, 12_000), voice: "af_heart", speed: 0.7 }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`TTS returned HTTP ${response.status}`);
  const wav = Buffer.from(await response.arrayBuffer());
  const { stdout } = await execFileAsync("/usr/bin/ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-c:a", "libopus", "-b:a", "32k", "-vbr", "on", "-f", "ogg", "pipe:1",
  ], { input: wav, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
  return stdout;
}
