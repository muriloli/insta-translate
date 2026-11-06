import { next } from '@vercel/functions';
import { authorized } from './lib/token.js';

// Só na Vercel: pede a senha (APP_PASSWORD) para o site inteiro, como o server.js faz localmente.
// Sem senha definida o site fica fechado: na internet, qualquer um gastaria a cota do Gemini.
export default function middleware(request) {
  if (!process.env.APP_PASSWORD) return new Response('Defina APP_PASSWORD nas variáveis de ambiente da Vercel.', { status: 503 });
  if (authorized(request.headers.get('authorization') ?? '')) return next();
  return new Response('Senha necessária', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="insta-translate"' } });
}
