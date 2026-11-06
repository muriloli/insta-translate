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
- **Sem realimentação:** enquanto uma sessão toca voz traduzida, a *outra* recebe silêncio no lugar do microfone, para não traduzir o alto-falante de volta. A sessão que está traduzindo continua ouvindo, porque o Gemini traduz enquanto a pessoa ainda fala e ignora a própria voz, que já está no idioma de destino.
- **Uma tradução por vez:** com sotaque, às vezes as duas sessões acham que a fala é do outro idioma e as duas traduzem. Nos testes, quem errou foi sempre a sessão do idioma da outra pessoa (repetia o inglês dito com sotaque). Por isso, quando a sessão do seu idioma está traduzindo, a outra fica calada.
- **Voz de cada lado:** o tradutor imita a voz de quem fala, e ela muda de uma frase para outra. Ele aceita `voiceName`, mas ignora a escolha (testado em nov/2026; [outro desenvolvedor relatou o mesmo](https://discuss.ai.google.dev/t/field-report-gemini-3-5-live-translate-preview-setup-schema-docs-runtime-mismatch-voice-pinning-silently-ignored-within-session-voice-drift/173369)). Ao escolher "Voz de mulher" ou "Voz de homem", o áudio do tradutor é descartado e uma segunda conexão (`gemini-3.1-flash-live-preview`, vozes Kore e Charon) lê o texto traduzido com voz fixa. O texto vai em moldura ("leia exatamente: «…»"), porque sem ela o modelo responde em vez de ler. Nas conversas gravadas, a voz fixa termina ~2 s depois do último texto, uns 0,5 a 1 s a mais que a voz original em frases curtas. O modo fone continua funcionando.
- **Conexão travada:** se uma das conexões não fica pronta em 8 s, o app abandona essa e tenta mais uma vez. Se travar de novo, mostra "Demorou para conectar".
- **Modo fone:** marcando a opção, a tradução para a outra pessoa sai no lado esquerdo e a sua no direito. Com fone não há eco. Fone com fio garante os dois lados separados; no Bluetooth, muitos celulares passam para mono quando o microfone está ligado.
- **Filtro de ruído** (Desligado / Normal / Forte): só passa o que estiver 8 ou 15 dB acima do ruído de fundo, que é medido o tempo todo. Ruído constante (restaurante, rua) fica de fora. Uma pessoa falando alto por perto ainda pode passar; nesse caso, segure o celular mais perto de quem fala ou use o microfone do fone.
- **Layout frente a frente:** a metade de cima fica de ponta-cabeça para quem está do outro lado da mesa.

### Diagnóstico

Abra o app com `?debug` no fim do link. Ele grava em `logs/` (fora do Git), a cada segundo:
- o nível do microfone;
- se o filtro e o bloqueio de eco estavam abertos;
- o que cada sessão ouviu e falou, com o idioma detectado;
- quando a voz tocou;
- o áudio do microfone, em PCM 16 kHz.

## Por que essa stack (pesquisa de nov/2026)

| Opção | Latência medida | Idiomas | Preço | Observação |
|---|---|---|---|---|
| **Gemini 3.5 Live Translate** (escolhida) | ~1,5 s do fim da frase até a tradução completa | 70+ (inclui pt-BR e pt-PT) | Grátis no plano free; ~US$ 0,037/min no pago | Fica calado no próprio idioma, o que permite o modo mãos-livres. Ainda em *preview*. |
| OpenAI `gpt-realtime-translate` | ~0,7 s até o 1º áudio, mas ~2,6 s até terminar a frase | 70+ de entrada, só 13 de saída | US$ 0,034/min por sessão | WebRTC nativo e já é GA. Não documenta o que faz com fala que já está no idioma de destino. |
| Soniox (STT `two_way` + TTS) | Sem número publicado (cadeia STT + TTS) | 60+ | ~US$ 0,82/hora | Mais barato e com legenda mais rápida, mas é uma cadeia de 2 conexões com mais código. |
| Meta SeamlessStreaming (self-host) | ~2 s | ~100 de entrada | Custo de GPU | Licença CC-BY-NC, não pode uso comercial. |

Os números da tabela vêm de testes publicados por fornecedores (não há benchmark independente). **Medido neste projeto** (nov/2026, falas de 7 e 10 s, en↔pt-BR): a voz traduzida começa ~3,4 s depois que a pessoa começa a falar e termina 1,8 a 2,5 s depois que ela para. A legenda termina ~0,4 s depois que ela para. Conectar leva ~2 s (token + sessão). Para uma conversa, o que mais importa é o tempo entre o fim da frase e o fim da tradução, porque só aí a outra pessoa responde. Por isso o Gemini ficou na frente. Se ele não agradar no seu uso real, a troca para a OpenAI mexe só em `public/app.js` e no `server.js`.

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

- `server.js`: serve a página e emite os tokens, cada um com a configuração da sua conexão (tradutor ou voz fixa).
- `public/app.js`: sessões, envio do microfone, reprodução e legendas.
- `public/worklet.js`: converte o microfone para PCM 16 kHz em blocos de 100 ms.
- `test.js`: confere a conversão de áudio (`npm test`).

## Limitações conhecidas

- Quem vai responder precisa esperar a tradução terminar de tocar. Enquanto ela toca, a sessão do outro idioma fica surda.
- O Gemini manda áudio sem parar (zeros quando não há tradução). O app só trata como voz os trechos com som.
- Se a conexão cair, o app reconecta, mas perde o que foi dito durante a troca.
- O próprio Google avisa que a detecção de idioma pode se confundir entre línguas parecidas (como espanhol e português) e com sotaque forte.
- Custo no plano pago: as duas sessões cobram a entrada de áudio (US$ 0,0053/min cada), mas só a que traduz cobra a saída (US$ 0,0315/min). Dá uns US$ 0,04 por minuto de conversa. Cada lado com voz fixa soma mais uma conexão, que cobra o áudio de saída no preço do modelo Live geral. O plano gratuito cobre o modelo, mas o Google pode usar o conteúdo para melhorar os produtos dele.

## Roadmap iOS nativo

A mesma arquitetura vale no iPhone: o app pede o token ao mesmo `server.js` e abre os WebSockets direto com o Google.

1. **Áudio:** `AVAudioEngine` com `setVoiceProcessingEnabled(true)`, que traz cancelamento de eco do sistema. Isso pode dispensar a surdez da outra sessão e permitir interromper.
2. **Rede:** `URLSessionWebSocketTask`, com o mesmo protocolo do `app.js`.
3. **Modo offline (opcional):** `SpeechAnalyzer` (iOS 26+) + framework `Translation` + `AVSpeechSynthesizer`, tudo no aparelho, sem custo por minuto e sem internet. A qualidade e a voz são inferiores às do Gemini, então serve de plano B.
