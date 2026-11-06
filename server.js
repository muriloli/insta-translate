import { createServer } from 'node:http';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { authorized, tokenResponse } from './lib/token.js';

const { GEMINI_API_KEY, PORT = 3000 } = process.env;
const LOGS = new URL('logs/', import.meta.url);
const DEBUG_FILES = { '/log': 'jsonl', '/audio': 'pcm' };
const MAX_BODY = 2e6;
const FILES = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/worklet.js': ['worklet.js', 'text/javascript'],
};

if (!GEMINI_API_KEY) throw new Error('Defina GEMINI_API_KEY no .env');

createServer(async (req, res) => {
  if (!authorized(req.headers.authorization)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="insta-translate"' });
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/api/token') {
    const r = await tokenResponse(url);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    return res.end(await r.text());
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
