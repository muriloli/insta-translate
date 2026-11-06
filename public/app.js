const WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=';
const MODEL = 'models/gemini-3.5-live-translate-preview';
const LANGS = 'af ak sq am ar hy az eu be bn bg my ca zh-Hans zh-Hant hr cs da nl en et fil fi fr gl ka de el gu ha he hi hu is id it ja jv kn kk km rw ko lo lv lt mk ms ml mr mn ne nb fa pl pt-BR pt-PT pa ro ru sr sd si sk sl es su sw sv ta te th tr uk ur uz vi zu'.split(' ');
const GAP_MS = 1500; // pausa que abre um novo parágrafo
const MIC_TAIL = 0.3; // segundos a mais de surdez da outra sessão depois que a voz traduzida termina (eco do alto-falante)
const MAX_LAG = 0.3; // fila de áudio acima disso: descarta silêncio para recuperar o atraso
const VOICE = 2000; // pico PCM16 acima disso conta como voz: o Gemini manda zeros sem tradução e ruídos de ~650 ao ouvir o próprio idioma; voz fica entre 12k e 23k
const GATE_HOLD = 6; // blocos de 100 ms que o filtro de ruído continua aberto depois da última fala (fim das palavras)
const DEBUG = new URLSearchParams(location.search).has('debug'); // ?debug manda eventos e o áudio do mic para logs/ no servidor

const $ = (id) => document.getElementById(id);
const display = new Intl.DisplayNames(['pt-BR'], { type: 'language' });
const name = (code) => display.of(code).replace(/^./, (c) => c.toUpperCase());
let ctx, stream, wakeLock, split, SILENCE, t0, logId, logTimer, noiseFloor, gateHold;
let sessions = [];
let logs = [];
let audio = [];

for (const [id, def] of [['mine', 'pt-BR'], ['their', 'en']]) {
  const sel = $(id);
  const value = localStorage[id] ?? def;
  sel.append(...LANGS.map((c) => new Option(name(c), c, false, c === value)).sort((a, b) => a.text.localeCompare(b.text)));
  sel.onchange = () => (localStorage[id] = sel.value);
}
$('split').checked = localStorage.split === '1';
$('split').onchange = () => (localStorage.split = $('split').checked ? '1' : '');
$('noise').value = localStorage.noise ?? '8';
$('noise').onchange = () => (localStorage.noise = $('noise').value);

$('go').onclick = () => (ctx ? stop() : start().catch(fail));

// Duas sessões em paralelo ouvindo o mesmo mic, uma por idioma de destino. Com echoTargetLanguage=false
// cada uma fica em silêncio quando a fala já está no seu idioma, então a conversa vira mãos-livres.
async function start() {
  ctx = new AudioContext();
  t0 = performance.now();
  noiseFloor = undefined;
  gateHold = 0;
  logs = [];
  audio = [];
  if (DEBUG) {
    logId = new Date().toISOString().slice(0, 19).replace(/\D/g, '');
    logTimer = setInterval(flush, 1000);
  }
  split = $('split').checked;
  log({ e: 'start', mine: $('mine').value, their: $('their').value, split, rate: ctx.sampleRate, ua: navigator.userAgent });
  setUI(true, 'Conectando…');
  // Modo fone: a tradução para a outra pessoa sai no lado esquerdo, a sua no direito.
  sessions = [session($('their').value, $('theirFeed'), -1), session($('mine').value, $('myFeed'), 1)];
  // O cancelamento de eco fica ligado mesmo com fone: no iPhone ele vem junto com a supressão de ruído do sistema.
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
  log({ e: 'stop' });
  if (DEBUG) {
    clearInterval(logTimer);
    flush();
  }
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
  log({ e: 'error', msg: e.message });
  stop();
  $('status').textContent = e.name === 'NotAllowedError' ? 'Permita o acesso ao microfone' : e.message;
}

function setUI(on, text) {
  $('go').classList.toggle('on', on);
  $('go').textContent = on ? 'Parar' : 'Iniciar';
  $('mine').disabled = $('their').disabled = $('split').disabled = on;
  $('status').textContent = text;
}

function session(lang, feed, pan) {
  const s = { lang, feed, end: 0, voiceEnd: 0, ready: false, out: ctx.destination };
  if (split) (s.out = new StereoPannerNode(ctx, { pan })).connect(ctx.destination);
  connect(s).catch(fail);
  return s;
}

async function connect(s) {
  const getToken = () => fetch(`/token?lang=${encodeURIComponent(s.lang)}`, { method: 'POST' }).catch(() => null);
  let r = await getToken();
  if (!r?.ok) r = await getToken(); // túnel ou servidor piscou: tenta mais uma vez
  if (!r) throw new Error('Sem conexão com o servidor. Tente de novo.');
  if (!r.ok) {
    const html = r.headers.get('content-type')?.includes('html');
    throw new Error(html ? `Servidor indisponível (${r.status}). Tente de novo.` : await r.text());
  }
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
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    }));
  ws.onmessage = ({ data }) => receive(s, JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)));
  ws.onclose = ({ code, reason }) => {
    log({ e: 'close', s: s.lang, code, reason });
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
    log({ e: 'ready', s: s.lang, outLat: ctx.outputLatency, baseLat: ctx.baseLatency });
    if (sessions.every((x) => x.ready)) $('status').textContent = 'Pode falar';
  }
  const c = msg.serverContent;
  if (c?.inputTranscription?.text) log({ e: 'heard', s: s.lang, text: c.inputTranscription.text, lang: c.inputTranscription.languageCode });
  if (c?.outputTranscription?.text) {
    log({ e: 'said', s: s.lang, text: c.outputTranscription.text, lang: c.outputTranscription.languageCode });
    write(s, c.outputTranscription.text);
  }
  for (const p of c?.modelTurn?.parts ?? []) if (p.inlineData) play(s, p.inlineData.data);
  if (!c && !msg.setupComplete) log({ e: 'msg', s: s.lang, keys: Object.keys(msg) });
}

// O Gemini traduz enquanto a pessoa ainda fala, então o mic não pode ser cortado para quem está traduzindo.
// Só a OUTRA sessão fica surda enquanto uma toca voz; a própria ignora a voz dela, que já está no idioma de destino.
// currentTime é o relógio do áudio; o som só sai do alto-falante outputLatency depois (bem mais no Bluetooth).
function send(pcm) {
  if (!ctx) return;
  const now = ctx.currentTime;
  const tail = MIC_TAIL + (ctx.outputLatency || 0);
  const lvl = level(pcm);
  const open = gate(lvl.db);
  const voice = open && audioMsg(pcm);
  const deaf = sessions.map((s) => !split && sessions.some((o) => o !== s && now < o.voiceEnd + tail));
  sessions.forEach((s, i) => s.ready && s.ws.send(!open || deaf[i] ? (SILENCE ??= audioMsg(new ArrayBuffer(pcm.byteLength))) : voice));
  if (DEBUG) {
    audio.push(pcm);
    log({ e: 'mic', ...lvl, open, floor: Math.round(noiseFloor), deaf: sessions.filter((_, i) => deaf[i]).map((s) => s.lang) });
  }
}

// Filtro de ruído: só passa o que estiver `margin` dB acima do ruído de fundo (conversas ao longe ficam de fora).
// O ruído de fundo desce na hora e sobe 1 dB/s, então acompanha o ambiente sem aprender a própria fala como ruído.
function gate(db) {
  noiseFloor = Math.min(db, (noiseFloor ?? db) + 0.1);
  const margin = +$('noise').value;
  if (!margin || db > noiseFloor + margin) gateHold = GATE_HOLD;
  return gateHold-- > 0;
}

function audioMsg(buf) {
  const data = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return JSON.stringify({ realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } });
}

function play(s, data) {
  const pcm = new Int16Array(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)).buffer);
  const pk = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const voice = pk > VOICE;
  const now = ctx.currentTime;
  if (!voice && s.end - now > MAX_LAG) return log({ e: 'drop', s: s.lang });
  // Com sotaque, as duas sessões às vezes acham que a fala é do outro idioma e ambas traduzem.
  // Nos testes a sessão certa começou antes; a que chega depois fica calada enquanto a outra fala.
  // ponytail: "quem começa primeiro" é heurística; decidir pelo idioma do inputTranscription se errar demais
  if (voice && s.voiceEnd <= now && sessions.some((o) => o !== s && o.voiceEnd > now)) return log({ e: 'mute', s: s.lang });
  const buf = ctx.createBuffer(1, pcm.length, 24000);
  buf.getChannelData(0).set(Float32Array.from(pcm, (v) => v / 32768));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(s.out);
  s.end = Math.max(s.end, now);
  src.start(s.end);
  s.end += buf.duration;
  if (voice) {
    s.voiceEnd = s.end;
    log({ e: 'voice', s: s.lang, pk, lag: Math.round((s.end - now) * 1000) });
  }
}

function write(s, text) {
  const now = performance.now();
  if (!s.p || now - s.last > GAP_MS) s.feed.append((s.p = document.createElement('p')));
  s.last = now;
  s.p.textContent += text;
  s.feed.scrollTop = s.feed.scrollHeight;
}

function log(e) {
  if (DEBUG) logs.push({ t: Math.round(performance.now() - t0), ...e });
}

// ponytail: os POSTs podem chegar fora de ordem se a rede travar; numerar os blocos se o áudio sair embaralhado
function flush() {
  if (logs.length) fetch(`/log?id=${logId}`, { method: 'POST', body: JSON.stringify(logs) });
  if (audio.length) fetch(`/audio?id=${logId}`, { method: 'POST', body: new Blob(audio) });
  logs = [];
  audio = [];
}

function level(buf) {
  const s = new Int16Array(buf);
  let sum = 0;
  let pk = 0;
  for (const v of s) {
    sum += v * v;
    pk = Math.max(pk, Math.abs(v));
  }
  return { db: Math.round(10 * Math.log10(sum / s.length / 32768 ** 2 + 1e-9)), pk };
}
