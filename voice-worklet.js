class NaviMicrophone extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(1024);
    this.used = 0;
  }

  process(inputs) {
    const mono = inputs[0]?.[0];
    if (!mono) return true;
    let offset = 0;
    while (offset < mono.length) {
      const count = Math.min(mono.length - offset, this.frame.length - this.used);
      this.frame.set(mono.subarray(offset, offset + count), this.used);
      this.used += count;
      offset += count;
      if (this.used === this.frame.length) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(1024);
        this.used = 0;
      }
    }
    return true;
  }
}

registerProcessor('navi-microphone', NaviMicrophone);
