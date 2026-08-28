import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_CHARS = 120_000;

function splitModel(entry) {
  const slash = entry.indexOf("/");
  if (slash <= 0 || slash === entry.length - 1) throw new Error("invalid model entry");
  return { provider: entry.slice(0, slash), model: entry.slice(slash + 1) };
}

async function loadState(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (typeof value.sessionId === "string" && typeof value.createdAt === "number" && typeof value.lastInteractionAt === "number") return value;
  } catch {}
  return { sessionId: randomUUID(), createdAt: Date.now(), lastInteractionAt: 0 };
}

async function saveState(file, state) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
}

function parseRpc(proc, onRecord) {
  let buffered = Buffer.alloc(0);
  proc.stdout.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length > MAX_LINE_BYTES) {
      proc.kill("SIGKILL");
      return;
    }
    let index;
    while ((index = buffered.indexOf(10)) !== -1) {
      const line = buffered.subarray(0, index);
      buffered = buffered.subarray(index + 1);
      if (!line.length) continue;
      try { onRecord(JSON.parse(line.toString("utf8"))); } catch {}
    }
  });
}

export class GroupAgent {
  constructor(group, config) {
    this.group = group;
    this.config = config;
    this.process = null;
    this.runningModel = null;
    this.stateFile = join(group.workspace, ".govorun-session.json");
    this.state = null;
  }

  async initialise() {
    await mkdir(this.group.workspace, { recursive: true, mode: 0o700 });
    this.state = await loadState(this.stateFile);
    await saveState(this.stateFile, this.state);
  }

  shouldReset(now = Date.now()) {
    return now - this.state.createdAt >= this.config.sessionMinAgeMs &&
      now - this.state.lastInteractionAt >= this.config.inactivityResetMs;
  }

  async reset() {
    this.stop();
    this.state = { sessionId: randomUUID(), createdAt: Date.now(), lastInteractionAt: 0 };
    await saveState(this.stateFile, this.state);
  }

  stop() {
    if (!this.process?.pid) return;
    try { process.kill(-this.process.pid, "SIGTERM"); } catch {}
    this.process = null;
    this.runningModel = null;
  }

  spawn(modelEntry) {
    this.stop();
    const { provider, model } = splitModel(modelEntry);
    const bin = process.env.PI_BIN || "/home/govorun/.npm-global/bin/pi";
    const args = ["--mode", "rpc", "--offline", "--provider", provider, "--model", model,
      "--thinking", this.config.models.thinking, "--session-id", this.state.sessionId];
    const env = {
      HOME: "/home/govorun",
      PATH: "/home/govorun/.npm-global/bin:/usr/local/bin:/usr/bin:/bin",
      NODE_ENV: "production",
      PI_OFFLINE: "1",
    };
    const proc = spawn(bin, args, {
      cwd: this.group.workspace,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = proc;
    this.runningModel = modelEntry;
    return proc;
  }

  async prompt(message) {
    if (!this.state) await this.initialise();
    if (this.shouldReset()) await this.reset();
    const attempts = [this.config.models.primary, this.config.models.fallback, this.config.models.primary];
    let lastError = "Govorun could not reach either configured model.";
    for (let index = 0; index < attempts.length; index++) {
      const model = attempts[index];
      try {
        const response = await this.promptWith(model, message);
        this.state.lastInteractionAt = Date.now();
        await saveState(this.stateFile, this.state);
        return response;
      } catch (error) {
        lastError = String(error?.message || error).slice(0, 1000);
        this.stop();
      }
    }
    throw new Error(lastError);
  }

  promptWith(model, message) {
    return new Promise((resolve, reject) => {
      // Each turn gets a short-lived RPC child. Context still persists through the
      // stable --session-id, while this prevents an idle child or its tools from
      // surviving between WhatsApp requests.
      const proc = this.spawn(model);
      let text = "";
      let settled = false;
      let stderr = "";
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (this.process === proc) {
          this.process = null;
          this.runningModel = null;
          try { process.kill(-proc.pid, "SIGTERM"); } catch {}
        }
        fn(value);
      };
      parseRpc(proc, (record) => {
        if (record.type === "message_update" && record.assistantMessageEvent?.type === "text_delta") {
          text += record.assistantMessageEvent.delta || "";
          if (text.length > MAX_RESPONSE_CHARS) {
            proc.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
            finish(resolve, `${text.slice(0, MAX_RESPONSE_CHARS)}\n\n[Response limited.]`);
          }
          return;
        }
        if (record.type === "agent_end") finish(resolve, text.trim() || "Done.");
        if (record.type === "error") finish(reject, new Error(String(record.error || "pi error")));
      });
      proc.stderr.on("data", (chunk) => { if (stderr.length < 4000) stderr += chunk.toString("utf8"); });
      proc.once("error", (error) => finish(reject, error));
      proc.once("close", (code) => {
        if (!settled) finish(reject, new Error(stderr || `pi exited ${code}`));
        if (this.process === proc) { this.process = null; this.runningModel = null; }
      });
      proc.stdin.write(JSON.stringify({ type: "prompt", message }) + "\n", (error) => {
        if (error) finish(reject, error);
      });
    });
  }
}
