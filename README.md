# Govorun

Govorun is the isolated WhatsApp group transport for a pi coding agent.

## Runtime

- Source: `/home/lepton/govorun`
- Promoted runtime: `/opt/govorun/app`
- Service: `govorun.service`, user `govorun`
- Group map: `/home/lepton/infra/govorun/groups.json` → `/etc/govorun/groups.json`
- WhatsApp linked-device state: `/home/govorun/.local/state/govorun/whatsapp-auth`
- Per-group sessions: `/home/govorun/groups/<slug>`
- Static publishing: `/var/www/mavali.top/projects/govorun`

The bridge only accepts configured WhatsApp group IDs. Messages are processed when
Govorun is mentioned, or when a YouTube URL is posted. Group-specific `AGENTS.md`
files are root-owned and read-only to the agent. The current family group is
configured for Russian responses. Voice notes use local faster-whisper for input
and a local Russian Piper voice (`ru_RU-dmitri-medium`) for replies.

## Deployment

Run `/usr/local/bin/deploy-govorun` after reviewing source changes. It runs exact
npm installation, syntax/tests/audit, transcription dependency checks and an
atomic root-owned runtime promotion with rollback. Group configuration is changed
with `/usr/local/bin/govorun-enable-group <jid> <slug>`.

## Credentials

OpenAI Codex OAuth belongs only in `/home/govorun/.pi/agent/auth.json`. The
separately scoped Venice key belongs only in
`/home/lepton/.secrets/services/govorun/venice.env`; use
`/usr/local/bin/govorun-set-venice-key` to enter it without shell history or chat.
Never copy either credential into this repository.
