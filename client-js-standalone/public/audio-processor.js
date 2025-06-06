class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._bufferSize = 4096;
    this._buffer = new Float32Array(this._bufferSize);
    this._bufferIndex = 0;
    this._vadThreshold = 0.1;
    this._energyThreshold = 0.01;
    this._speaking = false;
    this._lastProcessTime = 0;
    this._processInterval = 100; // Process every 100ms
    this._silenceCounter = 0;
    this._silenceThreshold = 10; // Number of silent frames before VAD state change
    this._frameCount = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const channel = input[0];

    if (!channel) return true;

    // Calculate energy level
    let energy = 0;
    for (let i = 0; i < channel.length; i++) {
      energy += channel[i] * channel[i];
    }
    energy = Math.sqrt(energy / channel.length);

    // Update VAD state with hysteresis
    const isSpeaking = energy > this._vadThreshold;
    if (isSpeaking) {
      this._silenceCounter = 0;
      if (!this._speaking) {
        this._speaking = true;
        this.port.postMessage({
          type: 'vadState',
          state: 'SPEAKING'
        });
      }
    } else {
      this._silenceCounter++;
      if (this._silenceCounter >= this._silenceThreshold && this._speaking) {
        this._speaking = false;
        this.port.postMessage({
          type: 'vadState',
          state: 'QUIET'
        });
      }
    }

    // Buffer audio data
    for (let i = 0; i < channel.length; i++) {
      this._buffer[this._bufferIndex++] = channel[i];

      if (this._bufferIndex >= this._bufferSize) {
        this._frameCount++;
        const currentTime = this._frameCount * (this._bufferSize / sampleRate) * 1000;

        if (currentTime - this._lastProcessTime >= this._processInterval) {
          // Only send audio data if speaking
          if (this._speaking) {
            // Send buffered audio data
            this.port.postMessage({
              type: 'audioData',
              audioData: this._buffer.slice()
            });
          }

          // Reset buffer
          this._bufferIndex = 0;
          this._lastProcessTime = currentTime;
        }
      }
    }

    return true;
  }
}

registerProcessor('audio-processor', AudioProcessor); 