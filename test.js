import assert from 'node:assert';

let Mic;
const chunks = [];
globalThis.AudioWorkletProcessor = class { port = { postMessage: (b) => chunks.push(new Int16Array(b)) }; };
globalThis.registerProcessor = (_, C) => (Mic = C);

for (const rate of [48000, 44100]) {
  globalThis.sampleRate = rate;
  await import(`./public/worklet.js?${rate}`);
  chunks.length = 0;
  const mic = new Mic();
  const block = new Float32Array(128).fill(0.5);
  for (let i = 0; i < Math.ceil(rate / 10 / 128); i++) mic.process([[block]]);

  assert.equal(chunks.length, 1, `${rate} Hz: 100 ms de áudio deve gerar 1 bloco`);
  assert.equal(chunks[0].length, 1600);
  assert(chunks[0].every((v) => Math.abs(v - 16383) <= 1), `${rate} Hz: amplitude preservada`);
}
console.log('ok');
