declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

const minSeconds = 3;
const maxSeconds = 10;
const pauseWindows = 3;
const quietLevel = 0.006;

class RehearsalCapture extends AudioWorkletProcessor {
  chunks: Float32Array[] = [];
  length = 0;
  slideId = "";
  active = false;
  levelFrames = 0;
  levelEnergy = 0;
  quietWindows = 0;
  peak = 0;
  seq = 0;

  constructor() {
    super();
    this.port.onmessage = event => {
      if (event.data.type === "peek") {
        const samples = this.samples();
        this.port.postMessage({ type: "partial", slideId: this.slideId, seq: this.seq, samples, sampleRate, peak: this.peak },
          [samples.buffer]);
      }
      if (event.data.type === "boundary") {
        this.flush();
        this.slideId = event.data.slideId;
        this.active = event.data.active;
        this.port.postMessage({ type: "boundary", id: event.data.id });
      }
    };
  }

  samples() {
    const samples = new Float32Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    return samples;
  }

  flush() {
    if (this.length) {
      const samples = this.samples();
      this.port.postMessage(
        { type: "audio", slideId: this.slideId, seq: this.seq++, samples, sampleRate, peak: this.peak, capturedAt: Date.now() },
        [samples.buffer],
      );
    }
    this.chunks = [];
    this.length = 0;
    this.quietWindows = 0;
    this.peak = 0;
  }

  process(inputs: Float32Array[][]) {
    const channel = inputs[0]?.[0];
    if (this.active && channel) {
      for (const value of channel) this.levelEnergy += value * value;
      this.levelFrames += channel.length;
      this.chunks.push(channel.slice());
      this.length += channel.length;
      if (this.levelFrames >= sampleRate / 10) {
        const rms = Math.sqrt(this.levelEnergy / this.levelFrames);
        this.port.postMessage({ type: "level", rms });
        this.levelFrames = 0;
        this.levelEnergy = 0;
        this.peak = Math.max(this.peak, rms);
        this.quietWindows = rms < quietLevel ? this.quietWindows + 1 : 0;
        // 単語の途中で Whisper に渡さないよう、自然な間で区切る。
        if (this.length >= sampleRate * minSeconds && this.quietWindows >= pauseWindows) this.flush();
      }
      if (this.length >= sampleRate * maxSeconds) this.flush();
    }
    return true;
  }
}

registerProcessor("rehearsal-capture", RehearsalCapture);
