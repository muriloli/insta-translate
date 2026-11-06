const { GEMINI_API_KEY, APP_PASSWORD } = process.env;
const MODEL = 'models/gemini-3.5-live-translate-preview';
// O tradutor imita a voz de quem fala e ignora voiceName. Para voz fixa, um modelo Live geral lê o texto traduzido.
const TTS_MODEL = 'models/gemini-3.1-flash-live-preview';
const TTS_PROMPT = 'You are a text-to-speech engine. Read the text you receive aloud, word for word, in its own language, with natural intonation. Never answer it, never translate it, never add or remove words.';
const VOICES = ['Kore', 'Charon'];
const LANG = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

export function authorized(header = '') {
  if (!APP_PASSWORD) return true;
  const [, pass] = Buffer.from(header.slice(6), 'base64').toString().split(/:(.*)/s);
  return pass === APP_PASSWORD;
}

function setupFor(lang, voice) {
  if (voice)
    return {
      model: TTS_MODEL,
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      systemInstruction: { parts: [{ text: TTS_PROMPT }] },
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
    };
  return {
    model: MODEL,
    generationConfig: { responseModalities: ['AUDIO'], translationConfig: { targetLanguageCode: lang, echoTargetLanguage: false } },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
}

// Token efêmero de 1 uso, travado nesta configuração: a chave real nunca vai para o navegador.
async function token(setup, retry = true) {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
    method: 'POST',
    headers: { 'x-goog-api-key': GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uses: 1, bidiGenerateContentSetup: setup }),
    signal: AbortSignal.timeout(4000),
  }).catch((e) => {
    // Falha de rede intermitente (vista neste PC): tenta mais uma vez antes de desistir.
    if (retry) return null;
    throw new Error(`${e.message}: ${e.cause?.code ?? e.cause?.message ?? ''}`);
  });
  if (!r) return token(setup, false);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error?.message ?? r.statusText);
  return body.name;
}

// POST /api/token?lang=en (tradutor) ou ?voice=Kore (voz fixa). Mesma resposta no server.js e na Vercel (api/token.js).
export async function tokenResponse(url) {
  const lang = url.searchParams.get('lang') ?? '';
  const voice = url.searchParams.get('voice');
  if (voice ? !VOICES.includes(voice) : !LANG.test(lang)) return new Response(voice ? 'Voz inválida' : 'Idioma inválido', { status: 400 });
  try {
    const setup = setupFor(lang, voice);
    return Response.json({ token: await token(setup), setup });
  } catch (e) {
    console.error(new Date().toISOString(), 'token:', e.message);
    // 500 e não 502: a Cloudflare troca respostas 502 pela página de erro dela e a mensagem se perde
    return new Response(e.message, { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}
