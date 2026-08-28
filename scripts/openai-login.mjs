import { createInterface } from "node:readline";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { openaiCodexOAuth } from "/home/govorun/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js";

const authFile = "/home/govorun/.pi/agent/auth.json";
const readline = createInterface({ input: process.stdin, output: process.stdout });
const ask = (message) => new Promise((resolve, reject) => {
  readline.question(`${message}\n`, resolve);
  readline.once("close", () => reject(new Error("login input closed")));
});
const interaction = {
  signal: AbortSignal.timeout(15 * 60 * 1000),
  notify(event) {
    if (event.type === "auth_url") {
      console.log(`GOVORUN_OPENAI_AUTH_URL=${event.url}`);
      console.log("Complete the login, then paste the final redirect URL below.");
    }
    if (event.type === "device_code") console.log("Unexpected device-code flow requested.");
  },
  async prompt(request) {
    if (request.type === "select") return "browser";
    if (request.type === "manual_code") return ask(request.message);
    throw new Error(`unsupported OAuth prompt: ${request.type}`);
  },
};

try {
  const credential = await openaiCodexOAuth.login(interaction);
  let auth = {};
  try { auth = JSON.parse(await readFile(authFile, "utf8")); } catch {}
  auth["openai-codex"] = credential;
  const temporary = `${authFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, authFile);
  console.log("GOVORUN_OPENAI_AUTH_SAVED");
} finally {
  readline.close();
}
