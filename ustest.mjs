import WebSocket from "ws";
const K=process.argv[2] || "KEY";
const model=process.argv[3]||"gemini-3.8-live";
const extra=JSON.parse(process.argv[4]||"{}");
const setup=Object.assign({
  model:`models/${model}`,
  generationConfig:{responseModalities:["AUDIO"],speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:"Kore"}}}},
  inputAudioTranscription:{}, outputAudioTranscription:{},
  systemInstruction:{parts:[{text:"hi"}]}
},extra);
const ws=new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${K}`);
ws.on('open',()=>{console.log('open');ws.send(JSON.stringify({setup}))});
ws.on('message',d=>{console.log('MSG',d.toString().slice(0,300));process.exit(0)});
ws.on('close',(c,r)=>{console.log('close',c,r.toString());process.exit(1)});
ws.on('error',e=>{console.log('err',e.message);process.exit(1)});
setTimeout(()=>{console.log('t');process.exit(1)},15000);
