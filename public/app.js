const WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=';
const LANGS = 'af ak sq am ar hy az eu be bn bg my ca zh-Hans zh-Hant hr cs da nl en et fil fi fr gl ka de el gu ha he hi hu is id it ja jv kn kk km rw ko lo lv lt mk ms ml mr mn ne nb fa pl pt-BR pt-PT pa ro ru sr sd si sk sl es su sw sv ta te th tr uk ur uz vi zu'.split(' ');
const GAP_MS = 1500; // pausa que abre um novo parágrafo
const MIC_TAIL = 0.3; // segundos a mais de surdez da outra sessão depois que a voz traduzida termina (eco do alto-falante)
const MAX_LAG = 0.3; // fila de áudio acima disso: descarta silêncio para recuperar o atraso
const VOICE = 2000; // pico PCM16 acima disso conta como voz: o Gemini manda zeros sem tradução e ruídos de ~650 ao ouvir o próprio idioma; voz fica entre 12k e 23k
const SAID_WINDOW = 1.5; // segundos depois do último texto traduzido para o meu idioma em que a outra sessão fica calada
const CONNECT_MS = 8000; // normal é ~2 s (token + sessão); o servidor ainda pode levar 4 s numa tentativa extra do token
const TTS_WAIT_MS = 800; // pausa no texto traduzido que manda o trecho para a voz fixa mesmo sem pontuação
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
for (const id of ['theirVoice', 'myVoice', 'noise']) {
  $(id).value = localStorage[id] ?? $(id).value;
  $(id).onchange = () => (localStorage[id] = $(id).value);
}

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
  log({ e: 'start', mine: $('mine').value, their: $('their').value, split, voices: [$('theirVoice').value, $('myVoice').value], rate: ctx.sampleRate, ua: navigator.userAgent });
  setUI(true, 'Conectando…');
  // Modo fone: a tradução para a outra pessoa sai no lado esquerdo, a sua no direito.
  sessions = [session($('their').value, $('theirFeed'), -1, $('theirVoice').value), session($('mine').value, $('myFeed'), 1, $('myVoice').value)];
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
  const old = sessions;
  sessions = [];
  for (const s of old) {
    s.ws?.close();
    s.tts?.ws?.close();
  }
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
  for (const id of ['mine', 'their', 'myVoice', 'theirVoice', 'split']) $(id).disabled = on;
  $('status').textContent = text;
}

// Com voz escolhida, o áudio do tradutor (que imita a voz de quem fala) é descartado e uma segunda conexão lê o texto traduzido.
function session(lang, feed, pan, voice) {
  const s = { lang, feed, end: 0, voiceEnd: 0, saidAt: -Infinity, out: ctx.destination, query: `lang=${encodeURIComponent(lang)}`, on: (msg) => receive(s, msg) };
  if (split) (s.out = new StereoPannerNode(ctx, { pan })).connect(ctx.destination);
  connect(s).catch(fail);
  if (voice) connect((s.tts = { lang: `${lang}/voz`, query: `voice=${voice}`, owner: s, text: '', on: (msg) => speak(s, msg) })).catch(fail);
  return s;
}

// c é a sessão de tradução ou a conexão de voz fixa dela (c.owner); a configuração vem do servidor junto com o token.
// live() fica falso quando o app para ou quando uma nova tentativa substitui esta (o socket antigo é ignorado).
async function connect(c, retried) {
  const attempt = (c.attempt = (c.attempt ?? 0) + 1);
  const live = () => sessions.includes(c.owner ?? c) && c.attempt === attempt;
  setTimeout(() => {
    if (c.ready || !live()) return;
    if (retried) return fail(new Error('Demorou para conectar. Tente de novo.'));
    // A rede às vezes trava uma conexão (visto neste PC): abandona esta e tenta mais uma vez.
    log({ e: 'retry', s: c.lang });
    const old = c.ws;
    connect(c, true).catch(fail);
    old?.close();
  }, CONNECT_MS);
  const getToken = () => fetch(`/token?${c.query}`, { method: 'POST' }).catch(() => null);
  let r = await getToken();
  if (!r?.ok) r = await getToken(); // túnel ou servidor piscou: tenta mais uma vez
  if (!r) throw new Error('Sem conexão com o servidor. Tente de novo.');
  if (!r.ok) {
    const html = r.headers.get('content-type')?.includes('html');
    throw new Error(html ? `Servidor indisponível (${r.status}). Tente de novo.` : await r.text());
  }
  const { token, setup } = await r.json();
  if (!live()) return;

  const ws = (c.ws = new WebSocket(WS + encodeURIComponent(token)));
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => ws.send(JSON.stringify({ setup }));
  ws.onmessage = ({ data }) => {
    if (!live()) return;
    const msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    if (msg.setupComplete) {
      c.ready = true;
      log({ e: 'ready', s: c.lang, outLat: ctx.outputLatency, baseLat: ctx.baseLatency });
      if (sessions.every((x) => x.ready && (!x.tts || x.tts.ready))) $('status').textContent = 'Pode falar';
    }
    c.on(msg);
  };
  ws.onclose = ({ code, reason }) => {
    log({ e: 'close', s: c.lang, code, reason });
    if (!live()) return;
    const wasReady = c.ready;
    c.ready = false;
    // ponytail: reconecta do zero e perde o trecho falado durante a troca; usar sessionResumption se incomodar
    if (wasReady) {
      $('status').textContent = 'Reconectando…';
      connect(c).catch(fail);
    } else fail(new Error(reason || `Conexão recusada (${code})`));
  };
}

function receive(s, msg) {
  const c = msg.serverContent;
  if (c?.inputTranscription?.text) log({ e: 'heard', s: s.lang, text: c.inputTranscription.text, lang: c.inputTranscription.languageCode });
  if (c?.outputTranscription?.text) {
    const text = c.outputTranscription.text;
    s.saidAt = ctx.currentTime;
    log({ e: 'said', s: s.lang, text, lang: c.outputTranscription.languageCode });
    write(s, text);
    if (s.tts) say(s, text);
    // A minha sessão está traduzindo: o texto que a outra juntou para a voz fixa é a repetição (veja play).
    const their = sessions[0];
    if (s !== their && their.tts) their.tts.text = '';
  }
  for (const p of c?.modelTurn?.parts ?? []) if (p.inlineData && !s.tts) play(s, p.inlineData.data);
  if (!c && !msg.setupComplete) log({ e: 'msg', s: s.lang, keys: Object.keys(msg) });
}

// Um trecho por vez: texto novo no meio da leitura interromperia o anterior.
function speak(s, msg) {
  const c = msg.serverContent;
  for (const p of c?.modelTurn?.parts ?? []) if (p.inlineData) play(s, p.inlineData.data, true);
  if (c?.outputTranscription?.text) log({ e: 'read', s: s.lang, text: c.outputTranscription.text });
  if (msg.setupComplete || c?.turnComplete) {
    s.tts.busy = false;
    say(s, '', true);
  }
}

// O tradutor manda o texto aos pedaços; a voz fixa recebe um trecho inteiro (até a pontuação) para não picotar a entonação.
function say(s, text, force) {
  const t = s.tts;
  t.text += text;
  clearTimeout(t.timer);
  if (!t.text.trim()) return;
  if (!force && !/[.,!?;:]\s*$/.test(t.text)) {
    t.timer = setTimeout(() => say(s, '', true), TTS_WAIT_MS);
    return;
  }
  if (t.busy || !t.ready) return;
  // Sem a moldura, o modelo de conversa responde aos trechos ("Good morning," virava "Good morning, how can I help you?").
  const framed = `Read this text aloud exactly, nothing else: «${t.text}»`;
  t.ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: framed }] }], turnComplete: true } }));
  log({ e: 'tts', s: s.lang, text: t.text });
  t.text = '';
  t.busy = true;
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

// tts: áudio da voz fixa, que só chega quando há fala; os trechos baixos são pausas entre palavras e não podem ser descartados.
function play(s, data, tts) {
  const pcm = new Int16Array(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)).buffer);
  const pk = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const voice = pk > VOICE;
  const now = ctx.currentTime;
  if (!voice && !tts && s.end - now > MAX_LAG) return log({ e: 'drop', s: s.lang });
  // Com sotaque, as duas sessões às vezes acham que a fala é do outro idioma e ambas traduzem.
  // Nos testes quem errou foi sempre a do idioma dele (repetiu o inglês), então vale a do meu idioma.
  // ponytail: se a minha sessão errar (repetir o meu português), a outra pessoa fica sem tradução; aí decidir pelo languageCode
  const [their, mine] = sessions;
  if (voice && s === their && (mine.voiceEnd > now || now - mine.saidAt < SAID_WINDOW)) return log({ e: 'mute', s: s.lang });
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
