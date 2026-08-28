import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const directory = await mkdtemp(join(tmpdir(), "govorun-tts-"));
  try {
    const wavPath = join(directory, "reply.wav");
    const piper = spawn("/opt/govorun/tts-venv/bin/piper", [
      "--model", "/opt/govorun/voices/ru_RU-dmitri-medium.onnx", "--output_file", wavPath,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    piper.stderr.on("data", (chunk) => { if (stderr.length < 4000) stderr += chunk.toString("utf8"); });
    const piperExit = new Promise((resolve, reject) => {
      piper.once("error", reject);
      piper.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `Piper exited ${code}`)));
    });
    piper.stdin.end(text.slice(0, 12_000));
    await piperExit;
    const wav = await readFile(wavPath);
    return await new Promise((resolve, reject) => {
    const proc = spawn("/usr/bin/ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-c:a", "libopus", "-b:a", "32k", "-vbr", "on", "-f", "ogg", "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const output = [];
    let outputBytes = 0;
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024 * 1024) proc.kill("SIGKILL");
      else output.push(chunk);
    });
    proc.stderr.on("data", (chunk) => { if (stderr.length < 4000) stderr += chunk.toString("utf8"); });
    proc.once("error", reject);
    proc.once("close", (code) => code === 0 ? resolve(Buffer.concat(output)) : reject(new Error(stderr || `ffmpeg exited ${code}`)));
      proc.stdin.end(wav);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
