import {
  RTVIClientOptions,
  RTVIMessage,
  RTVIEvent,
  Transport,
  TransportState,
  Tracks
} from "@pipecat-ai/client-js";
import * as protobuf from "protobufjs";
import { AudioProcessor } from '../audio/processor';
import { EventEmitter } from 'events';
import { WebsocketTransportParams } from "./types";

// Constants
const SAMPLE_RATE = 16000;
const NUM_CHANNELS = 1;
const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 1000;

// Interfaces
interface DecodedAudioFrame {
  audio: Uint8Array | number[];
  sampleRate: number;
  numChannels: number;
  pts?: number;
}

interface DecodedTextFrame {
  text: string;
}

interface DecodedTranscriptionFrame {
  text: string;
  user_id?: string;
  timestamp?: string;
}

interface DecodedStartInterruptionFrame {}
interface DecodedStopInterruptionFrame {}

interface ParsedPipecatFrame {
  audio?: DecodedAudioFrame;
  text?: DecodedTextFrame;
  transcription?: DecodedTranscriptionFrame;
  startInterruption?: DecodedStartInterruptionFrame;
  stopInterruption?: DecodedStopInterruptionFrame;
}

interface RTVIMessageData {
  text?: string;
  content?: string;
}

interface TransportCallbacks {
  onGenericMessage?: (data: unknown) => void;
  onMessageError?: (message: RTVIMessage) => void;
  onError?: (message: RTVIMessage) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onUserStartedSpeaking?: () => void;
  onUserStoppedSpeaking?: () => void;
  onBotStartedSpeaking?: () => void;
  onBotStoppedSpeaking?: () => void;
  onServerMessage?: (data: any) => void;
  onTransportStateChanged?: (state: TransportState) => void;
  onVADStateChanged?: (state: "SPEAKING" | "QUIET") => void;
  onEnergyLevelChanged?: (level: number) => void;
}

export class WebsocketTransport extends Transport {
  private static readonly SAMPLE_RATE = 16000;
  private static readonly NUM_CHANNELS = 1;
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly BASE_RECONNECT_DELAY_MS = 1000;

  private _ws: WebSocket | null = null;
  private audioProcessor: AudioProcessor;
  private _eventEmitter: EventEmitter;
  private reconnectAttempts = 0;
  private _internalState: TransportState = 'disconnected';
  private _audioContext: AudioContext | null = null;
  private _mediaStream: MediaStream | null = null;
  private _audioSource: MediaStreamAudioSourceNode | null = null;
  private _audioWorkletNode: AudioWorkletNode | null = null;
  private _frameRef: protobuf.Type | null = null;
  private _isMicEnabledInternal = false;
  private _isCamEnabledInternal = false;
  private _isScreenShareEnabledInternal = false;
  private _userIsSpeaking = false;
  private _botIsSpeaking = false;
  private _playTime = 0;
  private _lastMessageTime = 0;
  protected _callbacks: TransportCallbacks = {};
  protected _onMessage: (message: RTVIMessage) => void = () => {};
  private userSpeakingTimeout: NodeJS.Timeout | null = null;
  private botSpeakingTimeout: NodeJS.Timeout | null = null;
  private _serverUrl: string;
  private _apiKey?: string;

  constructor(params: WebsocketTransportParams) {
    super();
    this._serverUrl = params.url;
    this._apiKey = params.apiKey;
    this.audioProcessor = new AudioProcessor({
      sampleRate: WebsocketTransport.SAMPLE_RATE,
      channelCount: WebsocketTransport.NUM_CHANNELS
    });
    this._eventEmitter = new EventEmitter();
  }

  get state(): TransportState {
    return this._internalState;
  }

  set state(newState: TransportState) {
    if (this._internalState !== newState) {
      const oldState = this._internalState;
      this._internalState = newState;
      console.log(`[Transport] State changed from ${oldState} to: ${newState}`);
      if (this._callbacks.onTransportStateChanged) {
        this._callbacks.onTransportStateChanged(newState);
      }

      // Clean up when disconnecting/erroring
      if ((newState === "disconnected" || newState === "error") && this._isMicEnabledInternal) {
        this.enableMic(false).catch((err) =>
          console.error("[Transport] Error stopping mic on disconnect/error state:", err)
        );
      }
    }
  }

  async connect(authBundle?: Record<string, unknown>, abortController?: AbortController): Promise<void> {
    if (this.state === "connecting" || this.state === "connected" || this.state === "ready") {
      this.log(`Already in state: ${this.state}, no need to reconnect.`);
      return;
    }

    try {
      this.state = "connecting";
      this.log('Connecting to WebSocket...');

      // Create WebSocket URL with apiKey if available
      const wsUrl = new URL(this._serverUrl);
      if (this._apiKey) {
        wsUrl.searchParams.append('apiKey', this._apiKey);
      }

      this.log('Connecting to WebSocket server:', wsUrl.toString());

      // Initialize WebSocket first
      this._ws = new WebSocket(wsUrl.toString());
      this._ws.binaryType = "arraybuffer";

      // Set up message handler before onopen
      this._ws.onmessage = (event: MessageEvent) => {
        try {
          if (event.data instanceof ArrayBuffer) {
            this.handleBinaryMessage(event.data);
          } else if (typeof event.data === "string") {
            this.handleTextMessage(event.data);
          }
        } catch (error) {
          console.error("[Transport] Error handling message:", error);
          if (this._callbacks.onError) {
            this._callbacks.onError(RTVIMessage.error("Error handling message"));
          }
        }
      };

      this._ws.onopen = async () => {
        this.log('WebSocket connection established.');
        this.reconnectAttempts = 0;
        this.state = "connected";
        
        // Initialize audio after WebSocket is connected
        try {
          await this.initializeAudio();
          
          // Send ready message as binary
          this.sendReadyMessageBinary();
          
          if (this._callbacks.onConnected) {
            this._callbacks.onConnected();
          }
        } catch (error) {
          console.error("[Transport] Error initializing audio:", error);
          if (this._callbacks.onError) {
            this._callbacks.onError(RTVIMessage.error("Failed to initialize audio"));
          }
        }
      };

      this._ws.onclose = (event: CloseEvent) => {
        console.log(`[Transport] WebSocket connection closed. Code: ${event.code}, Reason: "${event.reason}"`);
        this.state = "disconnected";

        if (this._callbacks.onDisconnected) {
          this._callbacks.onDisconnected();
        }

        if (!event.wasClean && this.reconnectAttempts < WebsocketTransport.MAX_RECONNECT_ATTEMPTS) {
          const delay = this.calculateReconnectDelay();
          setTimeout(() => {
            this.connect(authBundle, new AbortController());
          }, delay);
          this.reconnectAttempts++;
        }
      };

      this._ws.onerror = (event: Event) => {
        console.error("[Transport] WebSocket error:", event);
        this.state = "error";
        if (this._callbacks.onError) {
          this._callbacks.onError(RTVIMessage.error("WebSocket connection error"));
        }
      };

    } catch (error) {
      this.log('Connection error:', error);
      this.state = "error";
      this.cleanup();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    console.log("[Transport] Disconnecting...");
    this.state = "disconnecting";

    if (this._isMicEnabledInternal) {
      await this.enableMic(false);
    }

    if (this._ws) {
      if (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING) {
        this._ws.close(1000, "Client initiated disconnect");
      }
      this._ws = null;
    }

    if (this._audioContext && this._audioContext.state === "running") {
      try {
        await this._audioContext.suspend();
      } catch (suspendError) {
        console.error("[Transport] Error suspending AudioContext:", suspendError);
      }
    }

    this.state = "disconnected";
    console.log("[Transport] Disconnected.");
  }

  private calculateReconnectDelay(): number {
    const baseDelay = WebsocketTransport.BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts);
    const maxDelay = 30000;
    const jitter = Math.random() * 0.3 + 0.85;
    return Math.min(baseDelay * jitter, maxDelay);
  }

  private async initializeAudio(): Promise<void> {
    try {
      if (!this._audioContext) {
        this._audioContext = new AudioContext({
          sampleRate: WebsocketTransport.SAMPLE_RATE,
          latencyHint: 'interactive'
        });
      }

      // Resume audio context if suspended
      if (this._audioContext.state === "suspended") {
        await this._audioContext.resume();
      }

      // Get user media with proper constraints
      this._mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: WebsocketTransport.SAMPLE_RATE,
          channelCount: WebsocketTransport.NUM_CHANNELS,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      // Create audio source
      this._audioSource = this._audioContext.createMediaStreamSource(this._mediaStream);

      // Load audio worklet
      const workletUrl = new URL('/audio-processor.js', window.location.origin).href;
      await this._audioContext.audioWorklet.addModule(workletUrl);
      
      // Create and connect audio worklet
      this._audioWorkletNode = new AudioWorkletNode(this._audioContext, 'audio-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: WebsocketTransport.NUM_CHANNELS,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: {
          sampleRate: WebsocketTransport.SAMPLE_RATE,
          bufferSize: 4096
        }
      });

      // Connect audio nodes
      this._audioSource.connect(this._audioWorkletNode);
      this._audioWorkletNode.connect(this._audioContext.destination);

      // Set up audio data handling
      this._audioWorkletNode.port.onmessage = (event) => {
        if (event.data.type === 'audioData') {
          const audioData = event.data.audioData;
          if (audioData && audioData.length > 0) {
            // Convert Float32Array to Int16Array
            const int16Array = new Int16Array(audioData.length);
            for (let i = 0; i < audioData.length; i++) {
              const val = Math.max(-1, Math.min(1, audioData[i]));
              int16Array[i] = val < 0 ? val * 32768 : val * 32767;
            }
            this.sendAudioData(int16Array);
          }
        } else if (event.data.type === 'vadState') {
          this.handleVADState(event.data.state);
        }
      };

      this.log('Audio initialized successfully');
    } catch (error) {
      this.log('Failed to initialize audio:', error);
      throw error;
    }
  }

  private handleVADState(state: "SPEAKING" | "QUIET"): void {
    if (state === "SPEAKING") {
      this._userIsSpeaking = true;
      if (this._callbacks.onUserStartedSpeaking) {
        this._callbacks.onUserStartedSpeaking();
      }
      window.dispatchEvent(new CustomEvent(RTVIEvent.UserStartedSpeaking));
    } else {
      this._userIsSpeaking = false;
      if (this._callbacks.onUserStoppedSpeaking) {
        this._callbacks.onUserStoppedSpeaking();
      }
      window.dispatchEvent(new CustomEvent(RTVIEvent.UserStoppedSpeaking));
    }

    if (this._callbacks.onVADStateChanged) {
      this._callbacks.onVADStateChanged(state);
    }
  }

  private handleAudioFrame(audioData: Uint8Array): void {
    try {
      if (!this._audioContext) {
        console.error("[Transport] AudioContext not initialized");
        return;
      }

      // Convert Uint8Array to Float32Array for Web Audio API
      const float32Array = new Float32Array(audioData.length / 2);
      const int16Array = new Int16Array(audioData.buffer);
      
      for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
      }

      // Create audio buffer
      const audioBuffer = this._audioContext.createBuffer(
        1, // mono
        float32Array.length,
        WebsocketTransport.SAMPLE_RATE
      );
      audioBuffer.copyToChannel(float32Array, 0);

      // Create and connect audio nodes
      const source = this._audioContext.createBufferSource();
      source.buffer = audioBuffer;

      const gainNode = this._audioContext.createGain();
      gainNode.gain.setValueAtTime(1, this._audioContext.currentTime);

      source.connect(gainNode);
      gainNode.connect(this._audioContext.destination);

      // Schedule playback
      const currentTime = this._audioContext.currentTime;
      const scheduledTime = Math.max(this._playTime, currentTime + 0.05);
      source.start(scheduledTime);
      this._playTime = scheduledTime + audioBuffer.duration;

      // Update bot speaking state
      this._botIsSpeaking = true;
      if (this._callbacks.onBotStartedSpeaking) {
        this._callbacks.onBotStartedSpeaking();
      }
      window.dispatchEvent(
        new CustomEvent("bot-speaking-state-changed", {
          detail: { isSpeaking: true },
        })
      );

      source.onended = () => {
        this._botIsSpeaking = false;
        if (this._callbacks.onBotStoppedSpeaking) {
          this._callbacks.onBotStoppedSpeaking();
        }
        window.dispatchEvent(
          new CustomEvent("bot-speaking-state-changed", {
            detail: { isSpeaking: false },
          })
        );
      };
    } catch (error) {
      console.error("[Transport] Error handling audio frame:", error);
    }
  }

  private sendAudioData(audioData: Int16Array): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN || !this._frameRef) {
      return;
    }

    try {
      // Create frame with proper audio format
      const frame = this._frameRef.create({
        audio: {
          audio: Array.from(new Uint8Array(audioData.buffer)),
          sampleRate: WebsocketTransport.SAMPLE_RATE,
          numChannels: WebsocketTransport.NUM_CHANNELS
        }
      });

      const encodedFrame = new Uint8Array(this._frameRef.encode(frame).finish());
      this._ws.send(encodedFrame);
    } catch (error) {
      console.error("[Transport] Error sending audio data:", error);
    }
  }

  async initialize(
    options: RTVIClientOptions,
    messageHandler: (message: RTVIMessage) => void,
  ): Promise<void> {
    this._options = options;
    this._callbacks = options.callbacks || {};
    this._onMessage = messageHandler;
    this.state = "initializing";

    this._isMicEnabledInternal = !!options.enableMic;
    this._isCamEnabledInternal = !!options.enableCam;

    try {
      if (typeof window === "undefined") {
        this.state = "error";
        throw new Error(
          "Transport initialization requires browser environment",
        );
      }

      try {
        const protoDefinition = `
          syntax = "proto3";
          package pipecat;
          
          message TextFrame {
            uint64 id = 1;
            string name = 2;
            string text = 3;
          }
          
          message AudioRawFrame {
            uint64 id = 1;
            string name = 2;
            bytes audio = 3;
            uint32 sample_rate = 4;
            uint32 num_channels = 5;
            optional uint64 pts = 6;
          }
          
          message TranscriptionFrame {
            uint64 id = 1;
            string name = 2;
            string text = 3;
            string user_id = 4;
            string timestamp = 5;
          }
          
          message Frame {
            oneof frame {
              TextFrame text = 1;
              AudioRawFrame audio = 2;
              TranscriptionFrame transcription = 3;
            }
          }`;

        const root = protobuf.parse(protoDefinition).root;
        this._frameRef = root.lookupType("pipecat.Frame");
        console.log(
          "[Transport] Protobuf definitions loaded successfully for pipecat.Frame.",
        );
      } catch (protoError) {
        this.state = "error";
        console.error(
          "[Transport] Fatal: Error loading protobuf definitions:",
          protoError,
        );
        console.error(
          "[Transport] Make sure frames.proto is properly bundled with the SDK",
        );
        throw protoError;
      }

      try {
        this._audioContext = new (window.AudioContext ||
          (window as any).webkitAudioContext)({
          latencyHint: "interactive",
          sampleRate: WebsocketTransport.SAMPLE_RATE,
        });
        console.log(
          "[Transport] AudioContext initialized with sample rate:",
          this._audioContext.sampleRate,
        );

        if (
          typeof window !== "undefined" &&
          "audioWorklet" in this._audioContext
        ) {
          try {
            await this._audioContext.audioWorklet.addModule(
              "/audio-processor.js",
            );
            console.log("[Transport] Audio worklet module loaded successfully");
          } catch (workletError) {
            console.warn(
              "[Transport] Failed to load audio worklet, will fallback to script processor:",
              workletError,
            );
          }
        }
      } catch (audioContextError) {
        this.state = "error";
        console.error(
          "[Transport] Error initializing AudioContext:",
          audioContextError,
        );
        throw audioContextError;
      }

      this.state = "initialized";
      console.log("[Transport] Initialization complete.");
    } catch (error) {
      this.state = "error";
      console.error(
        "[Transport] Error during transport initialization:",
        error,
      );
      throw error;
    }
  }

  private handleBinaryMessage(data: ArrayBuffer): void {
    try {
      if (!this._frameRef) {
        console.error("[Transport] Frame reference not initialized");
        return;
      }

      const decodedMessage = this._frameRef.decode(new Uint8Array(data));
      const frame = this.decodeFrame(decodedMessage);

      if (frame.audio) {
        this.handleAudioFrame(new Uint8Array(frame.audio.audio as number[]));
      } else if (frame.text) {
        this.handleTextFrame(frame.text);
      }
    } catch (error) {
      console.error("[Transport] Error processing binary message:", error);
    }
  }

  private handleTextMessage(data: string): void {
    try {
      const jsonData = JSON.parse(data);
      
      if (jsonData.type === "error") {
        console.error("[Transport] Server error:", jsonData.message);
        if (this._callbacks.onError) {
          this._callbacks.onError(RTVIMessage.error(jsonData.message));
        }
        return;
      }

      if (jsonData.type === "server-ready") {
        this.log("[Transport] Received server ready acknowledgment");
        return;
      }

      if (this._callbacks.onServerMessage) {
        this._callbacks.onServerMessage(jsonData);
      }
    } catch (error) {
      console.warn("[Transport] Non-JSON text message:", data);
    }
  }

  private handleTextFrame(frame: any): void {
    try {
      const textData = JSON.parse(frame.text);
      
      if (textData.type === "greeting") {
        // Handle initial greeting
        window.dispatchEvent(
          new CustomEvent("chat-message", {
            detail: {
              id: crypto.randomUUID(),
              content: textData.content,
              role: textData.role || "assistant",
              timestamp: new Date(textData.timestamp || Date.now()),
            },
          })
        );
      } else if (textData.type === "transcript" || textData.type === "transcript_update") {
        window.dispatchEvent(
          new CustomEvent("chat-message", {
            detail: {
              id: crypto.randomUUID(),
              content: textData.content,
              role: textData.role || "assistant",
              timestamp: new Date(textData.timestamp || Date.now()),
            },
          })
        );
      }

      if (this._callbacks.onServerMessage) {
        this._callbacks.onServerMessage(textData);
      }
    } catch (error) {
      console.error("[Transport] Error handling text frame:", error);
    }
  }

  private sendReadyMessageBinary(): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN || !this._frameRef) {
      this.log("[Transport.sendReadyMessage] WebSocket not ready");
      return;
    }

    try {
      const readyPayload = {
        text: {
          text: JSON.stringify({
            label: "rtvi-ai",
            type: "client-ready",
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            agent_config: {
              model: "gpt-4",
              temperature: 0.7,
              max_tokens: 150,
              stream: true,
              voice: "alloy",
              response_format: { type: "text" },
              sample_rate: WebsocketTransport.SAMPLE_RATE,
              num_channels: WebsocketTransport.NUM_CHANNELS,
              audio: {
                sample_rate: WebsocketTransport.SAMPLE_RATE,
                num_channels: WebsocketTransport.NUM_CHANNELS,
                format: "pcm16"
              }
            }
          })
        }
      };

      const frame = this._frameRef.create(readyPayload);
      const encoded = new Uint8Array(this._frameRef.encode(frame).finish());
      this._ws.send(encoded);
      
      this.state = "ready";
      this.log("[Transport] Ready message sent successfully");
    } catch (error) {
      console.error("[Transport] Error sending ready message:", error);
      if (this._callbacks.onError) {
        this._callbacks.onError(RTVIMessage.error("Failed to send ready message"));
      }
    }
  }

  private convertFloat32ToS16PCM(float32Data: Float32Array): Int16Array {
    const int16Array = new Int16Array(float32Data.length);
    for (let i = 0; i < float32Data.length; i++) {
      const val = Math.max(-1, Math.min(1, float32Data[i]));
      int16Array[i] = val < 0 ? val * 32768 : val * 32767;
    }
    return int16Array;
  }

  public async enableMic(enabled: boolean): Promise<void> {
    if (this._isMicEnabledInternal === enabled) return;

    try {
      if (enabled) {
        console.log("[Transport] Enabling microphone.");

        // Initialize AudioContext only after user interaction
      if (!this._audioContext) {
          this._audioContext = new AudioContext({
            sampleRate: 16000,
            latencyHint: 'interactive'
          });
        }

        // Request microphone access
        this._mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: 16000,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });

        // Create audio worklet
        try {
          await this._audioContext.audioWorklet.addModule('/audio-processor.js');
          this._audioWorkletNode = new AudioWorkletNode(this._audioContext, 'audio-processor');
        } catch (error) {
          console.warn("[Transport] Failed to load audio worklet, will fallback to script processor:", error);
          // Fallback to ScriptProcessorNode if worklet fails
          const scriptNode = this._audioContext.createScriptProcessor(4096, 1, 1);
          scriptNode.onaudioprocess = (e) => {
            const inputData = e.inputBuffer.getChannelData(0);
            // Process audio data here
          };
          this._audioWorkletNode = scriptNode as unknown as AudioWorkletNode;
        }

        // Connect audio nodes
        const source = this._audioContext.createMediaStreamSource(this._mediaStream);
        source.connect(this._audioWorkletNode);
        this._audioWorkletNode.connect(this._audioContext.destination);

        this._isMicEnabledInternal = true;
        console.log("[Transport] Microphone enabled successfully.");
    } else {
        console.log("[Transport] Disabling microphone.");
        if (this._mediaStream) {
          this._mediaStream.getTracks().forEach(track => track.stop());
          this._mediaStream = null;
        }
        if (this._audioWorkletNode) {
          this._audioWorkletNode.disconnect();
          this._audioWorkletNode = null;
        }
      this._isMicEnabledInternal = false;
      console.log("[Transport] Microphone disabled.");
      }
    } catch (error) {
      console.error("[Transport] Error toggling microphone:", error);
      throw error;
    }
  }

  private setupScriptProcessor() {
    console.log(
      "[Transport] Falling back to ScriptProcessorNode for audio processing",
    );

    if (!this._audioContext || !this._audioSource) {
      console.error(
        "[Transport] Cannot setup ScriptProcessor: missing AudioContext or AudioSource",
      );
      return;
    }

    const scriptProcessor = this._audioContext.createScriptProcessor(512, 1, 1);

    this._audioSource.connect(scriptProcessor);
    scriptProcessor.connect(this._audioContext.destination);

    scriptProcessor.onaudioprocess = (event) => {
      const audioData = event.inputBuffer.getChannelData(0);
      this.processAudioData(audioData);
    };
  }

  private processAudioData(audioData: Float32Array): void {
    if (
      !this._ws ||
      this._ws.readyState !== WebSocket.OPEN ||
      !this._frameRef
    ) {
      return;
    }

    const pcmS16ArrayForSending = this.convertFloat32ToS16PCM(audioData);
    const pcmByteArrayForSending = new Uint8Array(pcmS16ArrayForSending.buffer);
    const frame = this._frameRef.create({
      audio: {
        audio: Array.from(pcmByteArrayForSending),
        sampleRate: WebsocketTransport.SAMPLE_RATE,
        numChannels: WebsocketTransport.NUM_CHANNELS,
      },
    });

    const encodedFrame = new Uint8Array(this._frameRef.encode(frame).finish());
    this._ws.send(encodedFrame);
  }

  private cleanupAudioResources(): void {
    if (this._audioWorkletNode) {
      try {
        this._audioWorkletNode.disconnect();
      } catch (e) {}
      this._audioWorkletNode = null;
    }

    if (this._audioSource) {
      try {
        this._audioSource.disconnect();
      } catch (e) {}
      this._audioSource = null;
    }

    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach((track) => track.stop());
      this._mediaStream = null;
    }
  }

  get isMicEnabled(): boolean {
    return this._isMicEnabledInternal;
  }

  get isCamEnabled(): boolean {
    return this._isCamEnabledInternal;
  }

  get isSharingScreen(): boolean {
    return this._isScreenShareEnabledInternal;
  }

  get userIsSpeaking(): boolean {
    return this._userIsSpeaking;
  }

  get botIsSpeaking(): boolean {
    return this._botIsSpeaking;
  }

  async initDevices(): Promise<void> {
    console.log(
      "[Transport] initDevices called. (No-op in this simplified transport)",
    );
  }

  tracks(): Tracks {
    return { local: {}, bot: {} };
  }

  async enableCam(enable: boolean): Promise<void> {
    console.log(`[Transport] enableCam: ${enable} (No-op)`);
    this._isCamEnabledInternal = enable;
  }

  async enableScreenShare(enable: boolean): Promise<void> {
    console.log(`[Transport] enableScreenShare: ${enable} (No-op)`);
    this._isScreenShareEnabledInternal = enable;
  }

  async getAllMics(): Promise<MediaDeviceInfo[]> {
    return [];
  }
  async getAllCams(): Promise<MediaDeviceInfo[]> {
    return [];
  }
  async getAllSpeakers(): Promise<MediaDeviceInfo[]> {
    return [];
  }
  updateMic(micId: string): void {
      console.log("[Transport] updateMic:", micId);
    }
    updateCam(camId: string): void {
      console.log("[Transport] updateCam:", camId);
    }
    updateSpeaker(speakerId: string): void {
      console.log("[Transport] updateSpeaker:", speakerId);
    }
    get selectedMic() {
      return {};
    }
    get selectedCam() {
      return {};
    }
    get selectedSpeaker() {
      return {};
    }
  
    private calculateVolumeLevel(audioData: Float32Array): number {
      if (audioData.length === 0) return -100;
  
      let sumOfSquares = 0;
      for (let i = 0; i < audioData.length; i++) {
        sumOfSquares += audioData[i] * audioData[i];
      }
      const rms = Math.sqrt(sumOfSquares / audioData.length);
  
      const epsilon = 0.0000001;
      return 20 * Math.log10(Math.max(rms, epsilon));
    }
  
    private decodeFrame(decodedMessage: any): ParsedPipecatFrame {
      const frame: ParsedPipecatFrame = {};
  
      if (!decodedMessage) return frame;
  
      try {
        const frameObj = this._frameRef!.toObject(decodedMessage, {
          defaults: true,
        }) as any;
  
        if (frameObj.audio && frameObj.audio.audio) {
          frame.audio = {
            audio: frameObj.audio.audio,
            sampleRate: frameObj.audio.sampleRate || WebsocketTransport.SAMPLE_RATE,
            numChannels: frameObj.audio.numChannels || WebsocketTransport.NUM_CHANNELS,
            pts: frameObj.audio.pts,
          };
        }
  
        if (frameObj.text && frameObj.text.text) {
          frame.text = {
            text: frameObj.text.text,
          };
        }
  
        if (frameObj.transcription && frameObj.transcription.text) {
          frame.transcription = {
            text: frameObj.transcription.text,
            user_id: frameObj.transcription.user_id,
            timestamp: frameObj.transcription.timestamp,
          };
        }
  
        if (frameObj.startInterruption) {
          frame.startInterruption = {};
        }
  
        if (frameObj.stopInterruption) {
          frame.stopInterruption = {};
        }
      } catch (error) {
        console.error("[Transport] Error converting frame:", error);
      }
  
      return frame;
    }
  
    private monitorAudioQuality(audioData: Float32Array): void {
      let peakLevel = 0;
      let noiseFloor = Infinity;
      let zeroCrossings = 0;
  
      for (let i = 1; i < audioData.length; i++) {
        peakLevel = Math.max(peakLevel, Math.abs(audioData[i]));
  
        if (Math.abs(audioData[i]) > 0.0001) {
          noiseFloor = Math.min(noiseFloor, Math.abs(audioData[i]));
        }
  
        if (Math.sign(audioData[i]) !== Math.sign(audioData[i - 1])) {
          zeroCrossings++;
        }
      }
  
      const zeroCrossingRate = zeroCrossings / audioData.length;
  
      if (zeroCrossingRate > 0.3) {
        console.warn("[Transport] High frequency noise detected");
      }
  
      if (peakLevel > 0.9) {
        console.warn("[Transport] Audio clipping detected");
      }
  
      if (noiseFloor < 0.01 && peakLevel > 0.1) {
        console.warn("[Transport] High noise floor detected");
      }
    }
  
    private handleRTVIMessage(message: any): void {
      if (!this._onMessage) {
        console.warn(
          "[Transport] Received RTVI message but no message handler registered",
        );
        return;
      }
  
      this._onMessage(message);
  
      // Handle speaking states
      if (message.type === "rtvi:user:started_speaking") {
        console.log("[Transport] Received RTVI user started speaking message");
        this.handleUserSpeakingState(true);
      } else if (message.type === "rtvi:user:stopped_speaking") {
        console.log("[Transport] Received RTVI user stopped speaking message");
        this.handleUserSpeakingState(false);
      } else if (message.type === "rtvi:bot:started_speaking") {
        console.log("[Transport] Received RTVI bot started speaking message");
        this._botIsSpeaking = true;
  
        if (this.botSpeakingTimeout) {
          clearTimeout(this.botSpeakingTimeout);
          this.botSpeakingTimeout = null;
        }
  
        if (this._callbacks.onBotStartedSpeaking) {
          this._callbacks.onBotStartedSpeaking();
        }
      } else if (message.type === "rtvi:bot:stopped_speaking") {
        console.log("[Transport] Received RTVI bot stopped speaking message");
        this._botIsSpeaking = false;
  
        if (this._callbacks.onBotStoppedSpeaking) {
          this._callbacks.onBotStoppedSpeaking();
        }
      }
    }
  
    private handleUserSpeakingState(isSpeaking: boolean) {
      if (this._userIsSpeaking !== isSpeaking) {
        this._userIsSpeaking = isSpeaking;
  
        if (isSpeaking) {
          console.log("[Transport] User started speaking");
          window.dispatchEvent(new CustomEvent(RTVIEvent.UserStartedSpeaking));
  
          if (this.userSpeakingTimeout) {
            clearTimeout(this.userSpeakingTimeout);
            this.userSpeakingTimeout = null;
          }
  
          if (this._callbacks.onUserStartedSpeaking) {
            this._callbacks.onUserStartedSpeaking();
          }
        } else {
          console.log("[Transport] User stopped speaking");
  
          window.dispatchEvent(new CustomEvent(RTVIEvent.UserStoppedSpeaking));
  
          if (this._callbacks.onUserStoppedSpeaking) {
            this._callbacks.onUserStoppedSpeaking();
          }
        }
      }
    }
  
    public getAudioContext(): AudioContext {
      if (!this._audioContext) {
        throw new Error("AudioContext not initialized");
      }
      return this._audioContext;
    }
  
    // public async sendTextMessage(text: string): Promise<void> {
    //   if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
    //     console.error("[Transport] Cannot send text: WebSocket not connected");
    //     return;
    //   }

    private log(message: string, ...args: any[]): void {
      console.log(`[WebsocketTransport] ${message}`, ...args);
    }

    private cleanup(): void {
      if (this._ws) {
        this._ws.close();
        this._ws = null;
      }

      if (this._audioWorkletNode) {
        this._audioWorkletNode.disconnect();
        this._audioWorkletNode = null;
      }

      if (this._audioSource) {
        this._audioSource.disconnect();
        this._audioSource = null;
      }

      if (this._mediaStream) {
        this._mediaStream.getTracks().forEach(track => track.stop());
        this._mediaStream = null;
      }

      if (this._audioContext) {
        this._audioContext.close();
        this._audioContext = null;
      }
    }

    public sendReadyMessage(): void {
      this.sendReadyMessageBinary();
    }

    public sendMessage(message: RTVIMessage): void {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
        console.error("[Transport.sendMessage] WebSocket not connected");
        if (this._callbacks.onError) {
          this._callbacks.onError(RTVIMessage.error("WebSocket not connected"));
        }
        return;
      }

      try {
        if (message.type === "client-audio") {
          this.sendAudioMessage(message);
        } else {
          this.sendTextMessage(message);
        }
      } catch (error) {
        console.error("[Transport.sendMessage] Error sending message:", error);
        if (this._callbacks.onError) {
          this._callbacks.onError(RTVIMessage.error("Failed to send message"));
        }
      }
    }

    private sendAudioMessage(message: RTVIMessage): void {
      if (!this._frameRef) {
        throw new Error("Frame reference not initialized");
      }

      const audioData = message.data as { audio: Uint8Array };
      const frame = this._frameRef.create({
        audio: {
          audio: Array.from(audioData.audio),
          sampleRate: WebsocketTransport.SAMPLE_RATE,
          numChannels: WebsocketTransport.NUM_CHANNELS
        }
      });
      const encoded = new Uint8Array(this._frameRef.encode(frame).finish());
      this._ws!.send(encoded);
    }

    private sendTextMessage(message: RTVIMessage): void {
      if (!this._frameRef) {
        throw new Error("Frame reference not initialized");
      }

      const textData = message.data as { text: string };
      const frame = this._frameRef.create({
        text: {
          text: textData.text
        }
      });
      const encoded = new Uint8Array(this._frameRef.encode(frame).finish());
      this._ws!.send(encoded);
    }
  }
  