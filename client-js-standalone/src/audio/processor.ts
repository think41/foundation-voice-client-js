interface AudioProcessorOptions {
  sampleRate: number;
  channelCount: number;
}

export class AudioProcessor {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private audioSource: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private isProcessing: boolean = false;

  constructor(private options: AudioProcessorOptions) {}

  async initialize(audioContext: AudioContext, stream: MediaStream): Promise<void> {
    this.audioContext = audioContext;
    this.mediaStream = stream;

    // Create audio source from stream
    this.audioSource = this.audioContext.createMediaStreamSource(stream);

    // Create script processor for audio processing
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    
    // Set up audio processing
    this.processor.onaudioprocess = (event: AudioProcessingEvent) => {
      if (!this.isProcessing) return;
      
      const inputData = event.inputBuffer.getChannelData(0);
      const outputData = event.outputBuffer.getChannelData(0);
      
      // Process audio data
      for (let i = 0; i < inputData.length; i++) {
        outputData[i] = inputData[i];
      }
      
      // Emit processed audio data
      this.onAudioData?.(inputData);
    };

    // Connect nodes
    this.audioSource.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  start(onAudioData: (data: Float32Array) => void): void {
    if (!this.processor) {
      throw new Error('AudioProcessor not initialized');
    }
    this.isProcessing = true;
    this.onAudioData = onAudioData;
  }

  stop(): void {
    this.isProcessing = false;
    this.onAudioData = undefined;
    
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    
    if (this.audioSource) {
      this.audioSource.disconnect();
      this.audioSource = null;
    }
    
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
    
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  private onAudioData?: (data: Float32Array) => void;
} 