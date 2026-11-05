# Insta Translate

Tradução de conversa por voz em tempo real. Duas pessoas falam, cada uma no seu idioma, e o app traduz e fala na hora para a outra. Funciona com as mãos livres: o idioma de quem está falando é detectado sozinho, sem botão de "minha vez".

Hoje é um app web (celular ou computador). Depois vem o app nativo para iOS (veja o [roadmap](#roadmap-ios-nativo)).

## Como funciona

```
                 ┌────────────── navegador ──────────────┐
  mic ──► PCM 16 kHz ──┬──► WebSocket A (destino: idioma dele) ──► áudio + legenda na metade de cima
                       └──► WebSocket B (destino: meu idioma)  ──► áudio + legenda na metade de baixo
                 └────────────────────┬───────────────────┘
                                      │ só para pegar um token de 1 uso
                                 server.js (Node, sem dependências)
```

- **O áudio vai direto do navegador para o Google.** O servidor só emite um token temporário (1 uso, travado no modelo e no idioma). Não existe salto extra no caminho da voz, que é o que mais pesa na latência.
- **Modelo:** `gemini-3.5-live-translate-preview`, que traduz voz para voz em um só passo (sem a cadeia transcrever → traduzir → sintetizar) e mantém o tom e o ritmo de quem fala.
- **Conversa mãos-livres:** duas sessões ouvem o mesmo microfone. Com `echoTargetLanguage: false`, cada sessão fica calada quando a fala já está no seu idioma. Assim só a sessão certa responde.
- **Sem realimentação:** enquanto a tradução está tocando, o app manda silêncio no lugar do microfone, para o alto-falante não ser traduzido de novo.
- **Layout frente a frente:** a metade de cima fica de ponta-cabeça para quem está do outro lado da mesa.

## Por que essa stack (pesquisa de nov/2026)

| Opção | Latência medida | Idiomas | Preço | Observação |
|---|---|---|---|---|
| **Gemini 3.5 Live Translate** (escolhida) | ~1,5 s do fim da frase até a tradução completa | 70+ (inclui pt-BR e pt-PT) | ~US$ 0,037/min por sessão | Fica calado no próprio idioma, o que permite o modo mãos-livres. Ainda em *preview*. |
| OpenAI `gpt-realtime-translate` | ~0,7 s até o 1º áudio, mas ~2,6 s até terminar a frase | 70+ de entrada, só 13 de saída | US$ 0,034/min por sessão | WebRTC nativo e já é GA. Não documenta o que faz com fala que já está no idioma de destino. |
| Soniox (STT `two_way` + TTS) | Sem número publicado (cadeia STT + TTS) | 60+ | ~US$ 0,82/hora | Mais barato e com legenda mais rápida, mas é uma cadeia de 2 conexões com mais código. |
| Meta SeamlessStreaming (self-host) | ~2 s | ~100 de entrada | Custo de GPU | Licença CC-BY-NC, não pode uso comercial. |

Os números de latência são de testes publicados por fornecedores (não há benchmark independente). Para uma conversa, o que mais importa é o tempo entre o fim da frase e o fim da tradução, porque só aí a outra pessoa responde. Por isso o Gemini ficou na frente. Se ele não agradar no seu uso real, a troca para a OpenAI mexe só em `public/app.js` e no `server.js`.

Fontes: [Gemini Live Translate](https://ai.google.dev/gemini-api/docs/live-api/live-translate), [tokens efêmeros](https://ai.google.dev/gemini-api/docs/ephemeral-tokens), [OpenAI Realtime Translation](https://developers.openai.com/api/docs/guides/realtime-translation), [Soniox speech-to-speech](https://soniox.com/docs/translation/sts-translation), [comparativo Fora Soft](https://www.forasoft.com/blog/article/real-time-speech-translation-vendor-benchmarks), [testes de latência LiveLingo](https://www.livelingo.io/guides/gpt-live-translation).

## Rodar

Precisa de Node 22.9+ e de uma chave do Gemini ([Google AI Studio](https://aistudio.google.com/apikey)).

```bash
cp .env.example .env   # e preencha GEMINI_API_KEY
npm start              # http://localhost:3000
```

Escolha os dois idiomas, toque em **Iniciar** e espere aparecer "Pode falar". Use fone ou deixe o volume moderado.

### Testar no celular

Microfone no navegador exige HTTPS. O jeito mais rápido é abrir um túnel:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

### Deploy

Qualquer hospedagem Node (Render, Railway, Fly.io…). Configure `GEMINI_API_KEY` e **sempre** `APP_PASSWORD`. Sem senha, qualquer pessoa que achar a URL gasta os seus créditos.

## Arquivos

- `server.js`: serve a página e emite os tokens.
- `public/app.js`: sessões, envio do microfone, reprodução e legendas.
- `public/worklet.js`: converte o microfone para PCM 16 kHz em blocos de 100 ms.
- `test.js`: confere a conversão de áudio (`npm test`).

## Limitações conhecidas

- Enquanto a tradução toca, o microfone fica mudo. Interromper no meio não funciona.
- Se a conexão cair, o app reconecta, mas perde o que foi dito durante a troca.
- O próprio Google avisa que a detecção de idioma pode se confundir entre línguas parecidas (como espanhol e português) e com sotaque forte.
- Custo: são duas sessões abertas ao mesmo tempo, cerca de US$ 0,07 por minuto de conversa.

## Roadmap iOS nativo

A mesma arquitetura vale no iPhone: o app pede o token ao mesmo `server.js` e abre os WebSockets direto com o Google.

1. **Áudio:** `AVAudioEngine` com `setVoiceProcessingEnabled(true)`, que traz cancelamento de eco do sistema. Isso pode dispensar o "mic mudo" e permitir interromper.
2. **Rede:** `URLSessionWebSocketTask`, com o mesmo protocolo do `app.js`.
3. **Modo offline (opcional):** `SpeechAnalyzer` (iOS 26+) + framework `Translation` + `AVSpeechSynthesizer`, tudo no aparelho, sem custo por minuto e sem internet. A qualidade e a voz são inferiores às do Gemini, então serve de plano B.
