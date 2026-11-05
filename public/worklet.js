// Mic na taxa nativa (ex. 48 kHz) -> PCM16 mono 16 kHz, em blocos de 100 ms (formato pedido pelo Gemini).
class Mic extends AudioWorkletProcessor {
  step = sampleRate / 16000;
  acc = 0;
  sum = 0;
  cnt = 0;
  n = 0;
  out = new Int16Array(1600);

  process([[ch]]) {
    if (!ch) return true;
    for (const v of ch) {
      this.sum += v;
      this.cnt++;
      if (++this.acc < this.step) continue;
      this.acc -= this.step;
      // ponytail: média simples como passa-baixa; trocar por FIR se a transcrição sofrer
      this.out[this.n++] = Math.max(-1, Math.min(1, this.sum / this.cnt)) * 0x7fff;
      this.sum = this.cnt = 0;
      if (this.n === this.out.length) {
        this.port.postMessage(this.out.buffer, [this.out.buffer]);
        this.out = new Int16Array(1600);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('mic', Mic);
