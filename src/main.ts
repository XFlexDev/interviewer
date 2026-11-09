import "./style.css";
import { TalkingHead } from "@met4citizen/talkinghead";

declare const location: any;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Cfg = { company: string; role: string; temper: string; gender: string; name: string; notes: string; minutes: number };

let cfg: Cfg | null = null;
let ws: WebSocket | null = null;
let head: TalkingHead | null = null;
let headaudio: any = null;
let micCtx: AudioContext | null = null;
let micStream: MediaStream | null = null;
let micSendBuf: Int16Array[] = [];
let micSendLen = 0;
let muted = false;
let interviewEnded = false;
let callStartedAt = 0;
let clockTimer: number | null = null;
const transcript: { who: string; text: string }[] = [];
let curWho: string | null = null;
let curText = "";
let sessionId = "";
let aiVoiceOn = true;

const CAPTURE_SRC = `
class C extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('c', C);`;

function toast(msg: string, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), ms);
}

function show(id: string) {
  document.querySelectorAll(".screen").forEach((s) => {
    const el = s as HTMLElement;
    if (el.id === id) { el.classList.remove("leaving"); el.classList.add("active"); }
    else if (el.classList.contains("active")) { el.classList.add("leaving"); el.classList.remove("active"); setTimeout(() => el.classList.remove("leaving"), 400); }
  });
}

/* ---------- setup ---------- */

let gender = "f", temper = "standard";
document.querySelectorAll("#seg-gender button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#seg-gender button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on"); gender = (b as HTMLElement).dataset.v!;
  }));
document.querySelectorAll("#seg-temper button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#seg-temper button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on"); temper = (b as HTMLElement).dataset.v!;
  }));
$("f-minutes").addEventListener("input", () => { $("min-v").textContent = ($("f-minutes") as HTMLInputElement).value + " min"; });
$("btn-join").addEventListener("click", () => startCall());
$("btn-mute").addEventListener("click", toggleMute);
$("btn-end").addEventListener("click", () => endCall("you ended the call"));
$("btn-again").addEventListener("click", () => location.reload());
$("btn-copy").addEventListener("click", async () => {
  const t = transcript.map((x) => `${x.who === "ai" ? cfg?.name : "You"}: ${x.text}`).join("\n");
  await navigator.clipboard.writeText(t);
  toast("transcript copied");
});

function toggleMute() {
  muted = !muted;
  if (micStream) micStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
  $("btn-mute").classList.toggle("off", muted);
  toast(muted ? "muted" : "mic on", 1200);
}

/* ---------- transcript / captions ---------- */

const capsEl = $("caps");
function flushCur() {
  if (curText.trim()) transcript.push({ who: curWho || "ai", text: curText.trim() });
  curText = "";
}
function addCap(who: string, piece: string) {
  if (who !== curWho) { flushCur(); curWho = who; }
  curText += piece;
  renderCaps();
}
function renderCaps() {
  const lines: { who: string; text: string }[] = [...transcript.slice(-2), ...(curText ? [{ who: curWho!, text: curText }] : [])];
  capsEl.innerHTML = "";
  lines.slice(-3).forEach((l, i, arr) => {
    const d = document.createElement("div");
    d.className = `cap ${l.who}${i < arr.length - 1 ? " dim" : ""}`;
    d.innerHTML = `<span class="who">${l.who === "ai" ? (cfg?.name || "interviewer") : "you"}</span>${escapeHtml(l.text)}`;
    capsEl.appendChild(d);
  });
}
function escapeHtml(s: string) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

/* ---------- clock ---------- */
function startClock() {
  callStartedAt = Date.now();
  clockTimer = setInterval(() => {
    const s = Math.floor((Date.now() - callStartedAt) / 1000);
    $("clock").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 1000) as unknown as number;
}

/* ---------- avatar ---------- */

async function initAvatar() {
  head = new TalkingHead($("avatar") as any, {
    ttsEndpoint: "N/A",
    lipsyncModules: [],
    cameraView: "upper",
    mixerGainSpeech: 3,
    cameraDistance: -0.9,
    cameraRotateEnable: false,
    lightAmbientIntensity: 1.6,
    lightDirectIntensity: 1.6,
    lightSpotIntensity: 1.2,
    modelPixelRatio: Math.min(devicePixelRatio, 2),
  } as any);
  (window as any).head = head;
  await head.showAvatar({ url: `/avatars/${gender === "m" ? "david" : "julia"}.glb`, avatarMood: "neutral" });
  await head.streamStart({ sampleRate: 24000, lipsyncType: "visemes" },
    () => $("tile-ai").classList.add("speaking"),
    () => $("tile-ai").classList.remove("speaking"));
  head.audioStreamGainNode.gain.value = 0;
  head.start();

  const { HeadAudio } = await import("./vendor/headaudio.mjs");
  await head.audioCtx.audioWorklet.addModule("/headaudio/headworklet.min.mjs");
  headaudio = new HeadAudio(head.audioCtx);
  await headaudio.loadModel("/headaudio/model-en-mixed.bin");
  head.audioSpeechGainNode.connect(headaudio);
  headaudio.onvalue = (k: string, v: number) => {
    const m = (head as any).mtAvatar?.[k];
    if (m) { m.newvalue = v; m.needsUpdate = true; }
  };
  head.opt.update = headaudio.update.bind(headaudio);
  if (!aiVoiceOn) head.audioSpeechGainNode.gain.value = 0;
}

/* ---------- mic ---------- */

async function initMic() {
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  micCtx = new AudioContext({ sampleRate: 16000 });
  const url = URL.createObjectURL(new Blob([CAPTURE_SRC], { type: "application/javascript" }));
  await micCtx.audioWorklet.addModule(url);
  const src = micCtx.createMediaStreamSource(micStream);
  const node = new AudioWorkletNode(micCtx, "c");
  const silent = micCtx.createGain(); silent.gain.value = 0;
  node.onprocessorerror = () => {};
  node.port.onmessage = (e) => {
    if (muted || !ws || ws.readyState !== 1) return;
    const f32 = e.data as Float32Array;
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    micSendBuf.push(i16);
    micSendLen += i16.length;
    if (micSendLen >= 1600) {
      const merged = new Int16Array(micSendLen);
      let o = 0;
      for (const b of micSendBuf) { merged.set(b, o); o += b.length; }
      micSendBuf = []; micSendLen = 0;
      ws.send(merged.buffer);
    }
  };
  src.connect(node); node.connect(silent); silent.connect(micCtx.destination);
}

/* ---------- call ---------- */

async function startCall() {
  cfg = {
    company: ($("f-company") as HTMLInputElement).value.trim(),
    role: ($("f-role") as HTMLInputElement).value.trim(),
    temper, gender,
    name: ($("f-name") as HTMLInputElement).value.trim(),
    notes: ($("f-notes") as HTMLTextAreaElement).value.trim(),
    minutes: Number(($("f-minutes") as HTMLInputElement).value),
  };
  aiVoiceOn = ($("f-audio") as HTMLInputElement).checked;
  show("scr-call");
  $("ai-tag").textContent = "connecting…";
  $("ai-state").textContent = "connecting…";

  try { await initAvatar(); } catch (e) { toast("avatar failed: " + (e as any)?.message); console.error(e); }
  try { await initMic(); } catch (e) { toast("mic blocked — allow microphone and retry"); $("ai-state").textContent = "mic blocked"; return; }

  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/live`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => ws!.send(JSON.stringify({ type: "config", config: cfg }));
  ws.onmessage = (ev) => { if (ev.data instanceof ArrayBuffer) head?.streamAudio({ audio: ev.data }); else handleEvent(JSON.parse(ev.data)); };
  ws.onclose = () => { if (!interviewEnded) endCall("call ended"); };
  ws.onerror = () => toast("connection error");
}

function handleEvent(m: any) {
  switch (m.type) {
    case "ready":
      sessionId = m.sessionId; cfg = m.cfg || cfg;
      $("ai-tag").textContent = `${cfg!.name} — ${cfg!.company}`;
      $("ai-state").textContent = "on the line";
      startClock();
      ws!.send(JSON.stringify({ type: "say", text: "(The call just connected. Greet them, introduce yourself and the role, and start the interview.)" }));
      break;
    case "interrupted":
      head?.streamInterrupt();
      break;
    case "aiText": addCap("ai", m.text); break;
    case "userText": addCap("user", m.text); break;
    case "mood": (head as any)?.setMood?.(m.mood); break;
    case "gesture": (head as any)?.playGesture?.(m.gesture, 3, false, 800); break;
    case "reconnecting": toast("reconnecting…"); $("ai-state").textContent = "reconnecting…"; break;
    case "ended": interviewEnded = true; $("ai-state").textContent = "wrapped up"; break;
  }
}

function endCall(reason: string) {
  interviewEnded = true;
  if (clockTimer) clearInterval(clockTimer);
  try { ws?.send(JSON.stringify({ type: "end" })); } catch {}
  setTimeout(() => { try { ws?.close(); } catch {} }, 300);
  micStream?.getTracks().forEach((t) => t.stop());
  try { micCtx?.close(); } catch {}
  try { head?.streamStop(); } catch {}
  flushCur();
  show("scr-report");
  runReport(reason);
}

async function runReport(reason: string) {
  const body = $("report-body");
  body.innerHTML = `<p class="fine">${escapeHtml(reason)} · writing your scorecard…</p>`;
  try {
    const r = await fetch("/api/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cfg, transcript }) });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || "failed");
    renderReport(j);
  } catch (e) {
    body.innerHTML = `<p class="fine">scorecard failed (${escapeHtml(String(e))}) — transcript copied to clipboard anyway</p>`;
    try { await navigator.clipboard.writeText(transcript.map((x) => `${x.who === "ai" ? cfg?.name : "You"}: ${x.text}`).join("\n")); } catch {}
  }
}

function renderReport(j: any) {
  const body = $("report-body");
  const vCls = j.verdict === "Hire" ? "hire" : j.verdict === "No hire" ? "no" : "maybe";
  const circ = 2 * Math.PI * 40;
  body.innerHTML = `
    <div class="verdict-row">
      <svg class="ring" viewBox="0 0 96 96">
        <circle class="bgc" cx="48" cy="48" r="40"/>
        <circle class="fg" cx="48" cy="48" r="40" stroke-dasharray="${circ}" stroke-dashoffset="${circ}"/>
        <text class="num" x="48" y="56" text-anchor="middle" fill="#fff">${j.score}</text>
      </svg>
      <div><div class="verdict ${vCls}">${escapeHtml(j.verdict || "?")}</div><div class="fine" style="text-align:left">${escapeHtml(cfg!.name)} × ${escapeHtml(cfg!.company)} · ${escapeHtml(cfg!.role)}</div></div>
    </div>
    <p class="summary">${escapeHtml(j.summary || "")}</p>
    <div><div class="sec-title">breakdown</div><div class="cats">${(j.categories || []).map((c: any) => `
      <div class="cat"><span>${escapeHtml(c.name)}</span><span class="bar"><i data-w="${Math.min(100, c.score * 10)}"></i></span><span class="v">${c.score}</span></div>`).join("")}</div></div>
    ${(j.moments?.length ? `<div><div class="sec-title">the moments</div><div class="moments">${j.moments.map((m: any) => `
      <div class="moment"><q>${escapeHtml(m.quote)}</q><span>${escapeHtml(m.note)}</span></div>`).join("")}</div></div>` : "")}
    ${(j.tips?.length ? `<div><div class="sec-title">do better next time</div><div class="tips">${j.tips.map((t: string) => `<div>${escapeHtml(t)}</div>`).join("")}</div></div>` : "")}`;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const fg = body.querySelector(".ring .fg") as SVGCircleElement;
    fg.style.strokeDashoffset = String(circ * (1 - Math.min(100, j.score) / 100));
    body.querySelectorAll<HTMLElement>(".cat .bar i").forEach((el) => (el.style.width = el.dataset.w + "%"));
  }));
}
