import { createServer } from 'node:http';
import { appendFile, mkdir, readFile } from 'node:fs/promises';

const { GEMINI_API_KEY, APP_PASSWORD, PORT = 3000 } = process.env;
const MODEL = 'models/gemini-3.5-live-translate-preview';
const LANG = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const LOGS = new URL('logs/', import.meta.url);
const DEBUG_FILES = { '/log': 'jsonl', '/audio': 'pcm' };
const MAX_BODY = 2e6;
const FILES = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/worklet.js': ['worklet.js', 'text/javascript'],
};

if (!GEMINI_API_KEY) throw new Error('Defina GEMINI_API_KEY no .env');

// Token efêmero de 1 uso, travado no modelo e no idioma: a chave real nunca vai para o navegador.
async function token(lang, retry = true) {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
    method: 'POST',
    headers: { 'x-goog-api-key': GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uses: 1,
      bidiGenerateContentSetup: {
        model: MODEL,
        generationConfig: {
          responseModalities: ['AUDIO'],
          translationConfig: { targetLanguageCode: lang, echoTargetLanguage: false },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    }),
    signal: AbortSignal.timeout(4000),
  }).catch((e) => {
    // Falha de rede intermitente (vista neste PC): tenta mais uma vez antes de desistir.
    if (retry) return null;
    throw new Error(`${e.message}: ${e.cause?.code ?? e.cause?.message ?? ''}`);
  });
  if (!r) return token(lang, false);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error?.message ?? r.statusText);
  return body.name;
}

function authorized(req) {
  if (!APP_PASSWORD) return true;
  const [, pass] = Buffer.from((req.headers.authorization ?? '').slice(6), 'base64').toString().split(/:(.*)/s);
  return pass === APP_PASSWORD;
}

createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="insta-translate"' });
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/token') {
    const lang = url.searchParams.get('lang') ?? '';
    if (!LANG.test(lang)) {
      res.writeHead(400);
      return res.end('Idioma inválido');
    }
    try {
      const body = JSON.stringify({ token: await token(lang) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch (e) {
      console.error(new Date().toISOString(), 'token:', e.message);
      // 500 e não 502: a Cloudflare troca respostas 502 pela página de erro dela e a mensagem se perde
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(e.message);
    }
    return;
  }

  // Modo ?debug: o app manda eventos (jsonl) e o áudio do mic (PCM16 16 kHz) a cada segundo.
  const ext = req.method === 'POST' && DEBUG_FILES[url.pathname];
  if (ext) {
    const id = url.searchParams.get('id') ?? '';
    if (!/^\d{14}$/.test(id)) {
      res.writeHead(400);
      return res.end();
    }
    const parts = [];
    let size = 0;
    for await (const chunk of req) {
      if ((size += chunk.length) > MAX_BODY) {
        res.writeHead(413);
        return res.end();
      }
      parts.push(chunk);
    }
    if (ext === 'jsonl') parts.push(Buffer.from('\n'));
    await mkdir(LOGS, { recursive: true });
    await appendFile(new URL(`${id}.${ext}`, LOGS), Buffer.concat(parts));
    res.writeHead(204);
    return res.end();
  }

  const file = FILES[url.pathname];
  if (!file) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` });
  res.end(await readFile(new URL(`public/${file[0]}`, import.meta.url)));
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
