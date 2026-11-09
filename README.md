# interview

A real-time AI job-interview call in the browser. You set the company, role and
how much of a bitch the interviewer is; a lip-synced 3D avatar calls you,
runs a ~10-minute voice screening powered by Gemini 3.8 Live (native audio,
real VAD, interruptions), then writes a scorecard.

- `server/` — Node static + WS proxy to the Gemini Live API (server-side key
  rotation, session resumption, tool calls for mood/gesture/end, `/api/report`).
- `src/` — Vite + TypeScript frontend (TalkingHead avatar + HeadAudio viseme
  lip-sync, Web Audio mic capture at 16 kHz, live captions).

## Run

```sh
npm i
INTERVIEWER_KEYS=key1,key2 PORT=8787 node server/index.mjs
npx vite        # dev on :5199, proxies /live and /api
```

Prod: `npx vite build` then the server serves `dist/` on the same port.

Env: `INTERVIEWER_KEYS` (comma-separated Gemini API keys, round-robin with
cooldowns), `PORT`, `LIVE_MODEL`, `REPORT_MODEL`.
