const WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=';
const MODEL = 'models/gemini-3.5-live-translate-preview';
const LANGS = 'af ak sq am ar hy az eu be bn bg my ca zh-Hans zh-Hant hr cs da nl en et fil fi fr gl ka de el gu ha he hi hu is id it ja jv kn kk km rw ko lo lv lt mk ms ml mr mn ne nb fa pl pt-BR pt-PT pa ro ru sr sd si sk sl es su sw sv ta te th tr uk ur uz vi zu'.split(' ');
const GAP_MS = 1500; // pausa que abre um novo parágrafo
const MIC_TAIL = 0.3; // segundos a mais de surdez da outra sessão depois que a voz traduzida termina (eco do alto-falante)
const MAX_LAG = 0.3; // fila de áudio acima disso: descarta silêncio para recuperar o atraso
const VOICE = 500; // pico PCM16 acima disso conta como voz (o Gemini manda zeros quando não há tradução)

const $ = (id) => document.getElementById(id);
const display = new Intl.DisplayNames(['pt-BR'], { type: 'language' });
const name = (code) => display.of(code).replace(/^./, (c) => c.toUpperCase());
let ctx, stream, wakeLock, SILENCE;
let sessions = [];

for (const [id, def] of [['mine', 'pt-BR'], ['their', 'en']]) {
  const sel = $(id);
  const value = localStorage[id] ?? def;
  sel.append(...LANGS.map((c) => new Option(name(c), c, false, c === value)).sort((a, b) => a.text.localeCompare(b.text)));
  sel.onchange = () => (localStorage[id] = sel.value);
}

$('go').onclick = () => (ctx ? stop() : start().catch(fail));

// Duas sessões em paralelo ouvindo o mesmo mic, uma por idioma de destino. Com echoTargetLanguage=false
// cada uma fica em silêncio quando a fala já está no seu idioma, então a conversa vira mãos-livres.
async function start() {
  ctx = new AudioContext();
  setUI(true, 'Conectando…');
  sessions = [session($('their').value, $('theirFeed')), session($('mine').value, $('myFeed'))];
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  await ctx.audioWorklet.addModule('worklet.js');
  const mic = new AudioWorkletNode(ctx, 'mic');
  mic.port.onmessage = ({ data }) => send(data);
  ctx.createMediaStreamSource(stream).connect(mic).connect(ctx.destination);
  wakeLock = await navigator.wakeLock?.request('screen').catch(() => {});
}

function stop() {
  for (const s of sessions) s.ws?.close();
  sessions = [];
  stream?.getTracks().forEach((t) => t.stop());
  ctx?.close();
  ctx = stream = null;
  wakeLock?.release();
  setUI(false, 'Toque para começar');
}

function fail(e) {
  if (!ctx) return;
  stop();
  $('status').textContent = e.name === 'NotAllowedError' ? 'Permita o acesso ao microfone' : e.message;
}

function setUI(on, text) {
  $('go').classList.toggle('on', on);
  $('go').textContent = on ? 'Parar' : 'Iniciar';
  $('mine').disabled = $('their').disabled = on;
  $('status').textContent = text;
}

function session(lang, feed) {
  const s = { lang, feed, end: 0, voiceEnd: 0, ready: false };
  connect(s).catch(fail);
  return s;
}

async function connect(s) {
  const r = await fetch(`/token?lang=${encodeURIComponent(s.lang)}`, { method: 'POST' });
  if (!r.ok) throw new Error(await r.text());
  const { token } = await r.json();
  if (!sessions.includes(s)) return;

  const ws = (s.ws = new WebSocket(WS + encodeURIComponent(token)));
  ws.binaryType = 'arraybuffer';
  ws.onopen = () =>
    ws.send(JSON.stringify({
      setup: {
        model: MODEL,
        generationConfig: {
          responseModalities: ['AUDIO'],
          translationConfig: { targetLanguageCode: s.lang, echoTargetLanguage: false },
        },
        outputAudioTranscription: {},
      },
    }));
  ws.onmessage = ({ data }) => receive(s, JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)));
  ws.onclose = ({ code, reason }) => {
    const wasReady = s.ready;
    s.ready = false;
    if (!sessions.includes(s)) return;
    // ponytail: reconecta do zero e perde o trecho falado durante a troca; usar sessionResumption se incomodar
    if (wasReady) {
      $('status').textContent = 'Reconectando…';
      connect(s).catch(fail);
    } else fail(new Error(reason || `Conexão recusada (${code})`));
  };
}

function receive(s, msg) {
  if (msg.setupComplete) {
    s.ready = true;
    if (sessions.every((x) => x.ready)) $('status').textContent = 'Pode falar';
  }
  const c = msg.serverContent;
  if (c?.outputTranscription?.text) write(s, c.outputTranscription.text);
  for (const p of c?.modelTurn?.parts ?? []) if (p.inlineData) play(s, p.inlineData.data);
}

// O Gemini traduz enquanto a pessoa ainda fala, então o mic não pode ser cortado para quem está traduzindo.
// Só a OUTRA sessão fica surda enquanto uma toca voz; a própria ignora a voz dela, que já está no idioma de destino.
function send(pcm) {
  if (!ctx) return;
  const now = ctx.currentTime;
  const voice = audioMsg(pcm);
  for (const s of sessions) {
    if (!s.ready) continue;
    const otherTalking = sessions.some((o) => o !== s && now < o.voiceEnd + MIC_TAIL);
    s.ws.send(otherTalking ? (SILENCE ??= audioMsg(new ArrayBuffer(pcm.byteLength))) : voice);
  }
}

function audioMsg(buf) {
  const data = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return JSON.stringify({ realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } });
}

function play(s, data) {
  const pcm = new Int16Array(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)).buffer);
  const voice = pcm.some((v) => v > VOICE || v < -VOICE);
  if (!voice && s.end - ctx.currentTime > MAX_LAG) return;
  const buf = ctx.createBuffer(1, pcm.length, 24000);
  buf.getChannelData(0).set(Float32Array.from(pcm, (v) => v / 32768));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  s.end = Math.max(s.end, ctx.currentTime);
  src.start(s.end);
  s.end += buf.duration;
  if (voice) s.voiceEnd = s.end;
}

function write(s, text) {
  const now = performance.now();
  if (!s.p || now - s.last > GAP_MS) s.feed.append((s.p = document.createElement('p')));
  s.last = now;
  s.p.textContent += text;
  s.feed.scrollTop = s.feed.scrollHeight;
}
