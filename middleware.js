import { next } from '@vercel/functions';
import { authorized } from './lib/token.js';

// Só na Vercel: pede a senha (APP_PASSWORD) para o site inteiro, como o server.js faz localmente.
export default function middleware(request) {
  if (authorized(request.headers.get('authorization') ?? '')) return next();
  return new Response('Senha necessária', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="insta-translate"' } });
}
