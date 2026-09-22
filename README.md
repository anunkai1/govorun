# Govorun

Govorun is the isolated WhatsApp group transport for a pi coding agent.

> **Status:** this public repository is an archived bootstrap seed, last updated
> 29/08/2026, and is read-only on GitHub. It is **not** the running code.
> Govorun's live application is self-managed on its host under
> `/home/govorun/self/current`, which is not published here, so changes
> committed to this repository would not reach the running agent.

## Runtime

- Live application (private, self-managed): `/home/govorun/self/current`
- Bootstrap seed provisioned from this repository: `/opt/govorun/app`
- Service: `govorun.service`, user `govorun`
- Group map: `/home/lepton/infra/govorun/groups.json` → `/etc/govorun/groups.json`
- WhatsApp linked-device state: `/home/govorun/.local/state/govorun/whatsapp-auth`
- Per-group sessions: `/home/govorun/groups/<slug>`
- Static publishing: `/var/www/mavali.top/projects/govorun`

The bridge only accepts configured WhatsApp group IDs and explicitly allowlisted
1:1 WhatsApp IDs. Group messages are processed when Govorun is mentioned, or
when a YouTube URL is posted; allowlisted 1:1 messages do not need a mention.
Group-specific `AGENTS.md` files are root-owned and read-only to the agent. The
current family chat and the owner 1:1 chat are configured for Russian responses.
The agent can install extra tools inside each chat workspace without `sudo`;
workspace `bin/` and `.tools/venv/bin/` are on its `PATH`. Incoming WhatsApp
attachments are saved in that chat's `inbox/` and supplied to Pi as file paths.
Pi also loads the ACB workflow commands (`/research`, `/fetch`, `/codesearch`),
web/document access, multimodal image analysis, Browser Harness/captcha/Lappy
skills, and the self-project can be tested and activated with
`govorun-self-deploy`, which reloads the service and rolls back startup failures. Voice notes use local
faster-whisper for input and a local Russian Piper voice (`ru_RU-dmitri-medium`)
for replies. The voice-note window is armed only by the complete `listen`
command (optionally followed by `.` or `!`) after a mention is removed; ordinary
sentences such as “listen to this” do not trigger it.

## Deployment

`/usr/local/bin/deploy-govorun` provisions bootstrap assets from this
repository: the root-owned seed copy, the launcher and the browser-harness
skill. It does not install, replace or restart the running application.

The running application is updated in place from `/home/govorun/self/current`
with `govorun-self-deploy`, which runs the npm syntax/tests/audit gates,
commits the change and rolls back a release that fails during startup. Group
configuration is changed with
`/usr/local/bin/govorun-enable-group <jid> <slug>`.

## Credentials

OpenAI Codex OAuth belongs only in `/home/govorun/.pi/agent/auth.json`. The
separately scoped Venice key belongs only in
`/home/lepton/.secrets/services/govorun/venice.env`; use
`/usr/local/bin/govorun-set-venice-key` to enter it without shell history or chat.
Never copy either credential into this repository.
