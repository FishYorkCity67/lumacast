// AudioWorklet processors: the PCM tap that feeds the AAC encoder and a
// noise gate with hold, used on microphone channels.

class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.size = 960; // 20 ms @ 48 kHz
    this.buf = new Float32Array(this.size * 2);
    this.n = 0;
    this.port.onmessage = (e) => {
      this.on = !!e.data.on;
      this.n = 0;
    };
  }

  process(inputs) {
    if (!this.on) return true;
    const inp = inputs[0] || [];
    const L = inp[0];
    const R = inp[1] || inp[0];
    const frames = L ? L.length : 128;
    for (let i = 0; i < frames; i++) {
      this.buf[this.n * 2] = L ? L[i] : 0;
      this.buf[this.n * 2 + 1] = R ? R[i] : 0;
      if (++this.n === this.size) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(this.size * 2);
        this.n = 0;
      }
    }
    return true;
  }
}

class NoiseGate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -48, minValue: -100, maxValue: 0 },
      { name: 'enabled', defaultValue: 0, minValue: 0, maxValue: 1 },
    ];
  }

  constructor() {
    super();
    this.gain = 1;
    this.hold = 0;
  }

  process(inputs, outputs, params) {
    const inp = inputs[0];
    const out = outputs[0];
    if (!inp || !inp.length) return true;
    const enabled = params.enabled[0] > 0.5;
    const thr = 10 ** (params.threshold[0] / 20);
    const frames = inp[0].length;
    const holdSamples = sampleRate * 0.25;
    for (let i = 0; i < frames; i++) {
      let peak = 0;
      for (let c = 0; c < inp.length; c++) {
        const v = Math.abs(inp[c][i]);
        if (v > peak) peak = v;
      }
      if (peak > thr) this.hold = holdSamples;
      else if (this.hold > 0) this.hold--;
      const target = !enabled || this.hold > 0 ? 1 : 0;
      this.gain += (target - this.gain) * (target > this.gain ? 0.02 : 0.0012);
      for (let c = 0; c < out.length; c++) out[c][i] = (inp[c] || inp[0])[i] * this.gain;
    }
    return true;
  }
}

registerProcessor('lc-pcm-tap', PcmTap);
registerProcessor('lc-gate', NoiseGate);
