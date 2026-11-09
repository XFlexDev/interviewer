import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { normalizeConfig, systemPrompt, voiceFor, TOOLS, reportPrompt, REPORT_SCHEMA } from "./persona.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "dist");
const PORT = Number(process.env.PORT || 8787);
const KEYS = (process.env.INTERVIEWER_KEYS || process.env.GEMINI_KEYS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const LIVE_MODEL = process.env.LIVE_MODEL || "gemini-3.8-live";
const REPORT_MODEL = process.env.REPORT_MODEL || "gemini-3.5-flash";
const MAX_SESSION_MS = 22 * 60 * 1000;
const keyState = KEYS.map(() => ({ until: 0, fails: 0 }));
const connByIp = new Map();

function pickKey() {
  const now = Date.now();
  let best = -1, bestUntil = Infinity;
  for (let i = 0; i < KEYS.length; i++) {
    if (keyState[i].until <= now && keyState[i].until < bestUntil) { best = i; bestUntil = keyState[i].until; }
  }
  if (best === -1) best = Math.floor(Math.random() * KEYS.length);
  return best;
}
function coolKey(i, ms = 30000) {
  keyState[i].until = Date.now() + ms + Math.floor(Math.random() * 10000);
  keyState[i].fails++;
}
function okKey(i) { keyState[i].fails = 0; keyState[i].until = Date.now() + 60000; }

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".glb": "model/gltf-binary", ".bin": "application/octet-stream", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/report" && req.method === "POST") {
    let body = "";
    for await (const c of req) body += c;
    try {
      const { cfg, transcript } = JSON.parse(body || "{}");
      if (!Array.isArray(transcript) || transcript.length < 2) { res.writeHead(400); return res.end('{"error":"no transcript"}'); }
      const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${REPORT_MODEL}:generateContent?key=${KEYS[pickKey()]}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: reportPrompt(normalizeConfig(cfg), transcript.slice(-400)) }] }],
          generationConfig: { responseMimeType: "application/json", responseJsonSchema: REPORT_SCHEMA },
        }),
      });
      const j = await r.json();
      const text = j?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text;
      if (!text) { res.writeHead(502); return res.end(JSON.stringify({ error: "report failed", raw: JSON.stringify(j).slice(0, 300) })); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(text);
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
    return;
  }
  if (url.pathname === "/api/health") { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"ok":true,"keys":' + KEYS.length + "}"); }
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const f = path.normalize(path.join(ROOT, p));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/live") return socket.destroy();
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "?";
  const n = (connByIp.get(ip) || 0);
  if (n >= 3) { socket.write("HTTP/1.1 429 Too Many\r\n\r\n"); return socket.destroy(); }
  connByIp.set(ip, n + 1);
  wss.handleUpgrade(req, socket, head, (ws) => { ws._ip = ip; wss.emit("connection", ws, req); });
});
wss.on("close", () => {});

class LiveSession {
  constructor(client, ip) {
    this.client = client; this.ip = ip; this.cfg = null;
    this.transcript = [];
    this.up = null; this.upKey = -1; this.setupDone = false;
    this.sessionResumption = null; this.goAway = false; this.closed = false;
    this.hardTimer = setTimeout(() => this.finish("time"), MAX_SESSION_MS);
    client.on("message", (data, isBinary) => this.onClient(data, isBinary));
    client.on("close", () => this.finish("client"));
    client.on("error", () => this.finish("error"));
  }
  send(o) { if (this.client.readyState === WebSocket.OPEN) this.client.send(JSON.stringify(o)); }
  sendBin(b) { if (this.client.readyState === WebSocket.OPEN) this.client.send(b, { binary: true }); }
  transcriptAdd(who, text) {
    const t = text.trim();
    if (!t) return;
    const last = this.transcript[this.transcript.length - 1];
    if (last && last.who === who) last.text += " " + t; else this.transcript.push({ who, text: t });
    if (this.transcript.length > 800) this.transcript.splice(0, 200);
  }
  onClient(data, isBinary) {
    if (isBinary) {
      if (this.up && this.up.readyState === WebSocket.OPEN && this.setupDone)
        this.up.send(JSON.stringify({ realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: data.toString("base64") }] } }));
      return;
    }
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.type === "config" && !this.cfg) {
      this.cfg = normalizeConfig(m.config);
      this.connectUpstream();
    } else if (m.type === "frame" && this.up?.readyState === WebSocket.OPEN && this.setupDone && m.data)
      this.up.send(JSON.stringify({ realtimeInput: { mediaChunks: [{ mimeType: "image/jpeg", data: m.data }] } }));
    else if (m.type === "say" && this.setupDone && this.up?.readyState === WebSocket.OPEN)
      this.up.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: m.text }] }], turnComplete: true } }));
    else if (m.type === "end") this.finish("done");
  }
  connectUpstream() {
    if (this.closed) return;
    const ki = pickKey(); this.upKey = ki;
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${KEYS[ki]}`;
    const up = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    this.up = up;
    up.on("open", () => {
      console.log("upstream open, key", ki);
      up.send(JSON.stringify({
        setup: {
          model: `models/${LIVE_MODEL}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceFor(this.cfg) } } },
          },
          inputAudioTranscription: {}, outputAudioTranscription: {},
          systemInstruction: { parts: [{ text: systemPrompt(this.cfg) }] },
          tools: TOOLS,
          realtimeInputConfig: { automaticActivityDetection: { disabled: false, startOfSpeechSensitivity: "START_SENSITIVITY_HIGH", endOfSpeechSensitivity: "END_SENSITIVITY_LOW", silenceDurationMs: 700 } },
          contextWindowCompression: { slidingWindow: { targetTokens: 24000 } },
          sessionResumption: this.sessionResumption ? { handle: this.sessionResumption } : {},
        },
      }));
      okKey(ki);
    });
    up.on("message", (data, isBinary) => this.onUpstream(data, isBinary));
    up.on("unexpected-response", (req, res) => { console.log("upstream unexpected", res.statusCode); coolKey(ki, 60000); });
    up.on("close", (code) => {
      if (this.closed) return;
      console.log("upstream close", code);
      if (code === 1000 || code === 1001) return this.finish(code === 1000 ? "done" : "closed");
      if (this.setupDone && !this.goAway) { coolKey(ki, 15000); this.reconnect(); }
    });
    up.on("error", (e) => { console.log("upstream err", ki, e?.message); coolKey(ki, 30000); });
  }
  reconnect() {
    if (this.closed) return;
    this.send({ type: "reconnecting" });
    setTimeout(() => this.connectUpstream(), 800);
  }
  onUpstream(data, isBinary) {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.setupComplete) { this.setupDone = true; this.send({ type: "ready", sessionId: crypto.randomUUID().slice(0, 8), cfg: this.cfg }); return; }
    if (m.sessionResumptionUpdate?.resumable) this.sessionResumption = m.sessionResumptionUpdate.newHandle;
    if (m.goAway) { this.goAway = true; this.reconnect(); return; }
    const sc = m.serverContent;
    if (sc) {
      if (sc.interrupted) { this.send({ type: "interrupted" }); }
      for (const p of sc.modelTurn?.parts || []) {
        if (p.inlineData?.data) {
          const mime = p.inlineData.mimeType || "";
          if (mime.includes("audio")) {
            const b = Buffer.from(p.inlineData.data, "base64");
            this.sendBin(b);
          }
        }
      }
      if (sc.inputTranscription?.text) { this.transcriptAdd("user", sc.inputTranscription.text); this.send({ type: "userText", text: sc.inputTranscription.text }); }
      if (sc.outputTranscription?.text) { this.transcriptAdd("ai", sc.outputTranscription.text); this.send({ type: "aiText", text: sc.outputTranscription.text }); }
      if (sc.turnComplete) this.send({ type: "turnComplete" });
    }
    if (m.toolCall) {
      const fr = m.toolCall.functionCalls || [];
      const responses = [];
      for (const f of fr) {
        if (f.name === "set_mood") this.send({ type: "mood", mood: f.args?.mood });
        else if (f.name === "make_gesture") this.send({ type: "gesture", gesture: f.args?.gesture });
        else if (f.name === "end_interview") { this.send({ type: "ended" }); setTimeout(() => this.finish("done"), 4000); }
        responses.push({ id: f.id, name: f.name, response: { ok: true } });
      }
      if (responses.length && this.up?.readyState === WebSocket.OPEN)
        this.up.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
    }
  }
  finish(reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.hardTimer);
    try { this.up?.close(); } catch {}
    try { this.client.close(1000, reason); } catch {}
    connByIp.set(this.ip, Math.max(0, (connByIp.get(this.ip) || 1) - 1));
  }
}

wss.on("connection", (ws, req) => new LiveSession(ws, ws._ip));

server.listen(PORT, "127.0.0.1", () => console.log(`interviewer on ${PORT}, keys=${KEYS.length}, model=${LIVE_MODEL}`));
