import { authorized, tokenResponse } from '../lib/token.js';

export function POST(request) {
  if (!authorized(request.headers.get('authorization') ?? '')) return new Response(null, { status: 401 });
  return tokenResponse(new URL(request.url));
}
