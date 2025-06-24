import {
    Transport,
    TransportState,
    RTVIMessage,
    RTVIClientOptions,
    Tracks,
} from "@pipecat-ai/client-js";
import { WebSocketTransport } from "@pipecat-ai/websocket-transport";
import { DailyTransport } from "@pipecat-ai/daily-transport";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";
import { GeminiLiveWebsocketTransport, GeminiLLMServiceOptions } from '@pipecat-ai/gemini-live-websocket-transport';
import { OpenAIRealTimeWebRTCTransport, OpenAIServiceOptions } from '@pipecat-ai/openai-realtime-webrtc-transport';

export type TransportType = 
    | "websocket" 
    | "daily" 
    | "webrtc" 
    | "gemini"
    | "openai";

export interface TransportConfig {
    websocket: {
        serializer: any; // WebSocketSerializer type
        recorderSampleRate?: number;
        playerSampleRate?: number;
    }; 
    daily: any; 
    webrtc: any; 
    gemini: GeminiLLMServiceOptions;
    openai: OpenAIServiceOptions;
}

export class TransportFactory {
    private static isBrowser(): boolean {
        return typeof window !== 'undefined' && typeof window.document !== 'undefined';
    }

    static create<T extends TransportType>(
        transportType: T, 
        options: TransportConfig[T]
    ): Transport {
        if (!this.isBrowser()) {
            throw new Error('Transport can only be created in a browser environment');
        }

        switch (transportType) {
            case "websocket":
                return new WebSocketTransport(options as TransportConfig["websocket"]) as unknown as Transport;

            case "daily":
                return new DailyTransport(options) as unknown as Transport;
                
            case "webrtc":
                return new SmallWebRTCTransport(options) as unknown as Transport;
                
            case "gemini":
                return new GeminiLiveWebsocketTransport(options as GeminiLLMServiceOptions) as unknown as Transport;
                
            case "openai":
                return new OpenAIRealTimeWebRTCTransport(options as OpenAIServiceOptions) as unknown as Transport;
                
            default:
                throw new Error(`Unsupported transport type: ${transportType}`);
        }
    }

    static getAvailableTransports(): TransportType[] {
        return ["websocket", "daily", "webrtc", "gemini", "openai"];
    }
}

export class TransportManager {
    private transport: Transport | null = null;
    private transportType: TransportType;
    private transportOptions: TransportConfig[TransportType];

    constructor(
        transportType: TransportType, 
        options: TransportConfig[TransportType]
    ) {
        this.transportType = transportType;
        this.transportOptions = options;
    }

    private ensureTransport(): Transport {
        if (!this.transport) {
            this.transport = TransportFactory.create(this.transportType, this.transportOptions);
        }
        return this.transport;
    }
    
    async initialize(options: RTVIClientOptions, messageHandler: (message: RTVIMessage) => void): Promise<void> {
        return this.ensureTransport().initialize(options, messageHandler);
    }

    async connect(authBundle: Record<string, unknown>, abortController: AbortController): Promise<void> {
        return this.ensureTransport().connect(authBundle, abortController);
    }

    async disconnect(): Promise<void> {
        if (this.transport) {
            return this.transport.disconnect();
        }
    }

    get instance(): Transport {
        return this.ensureTransport();
    }

    get state(): TransportState {
        return this.ensureTransport().state;
    }

    tracks(): Tracks {
        return this.ensureTransport().tracks();
    }

    async enableMic(enable: boolean): Promise<void> {
        await this.ensureTransport().enableMic(enable);
    }

    async enableCam(enable: boolean): Promise<void> {
        await this.ensureTransport().enableCam(enable);
    }

    enableScreenShare(enable: boolean): void {
        this.ensureTransport().enableScreenShare(enable);
    }

    get isSharingScreen(): boolean {
        return this.ensureTransport().isSharingScreen;
    }

    get isCamEnabled(): boolean {
        return this.ensureTransport().isCamEnabled;
    }

    get isMicEnabled(): boolean {
        return this.ensureTransport().isMicEnabled;
    }

    sendMessage(message: RTVIMessage): void {
        this.ensureTransport().sendMessage(message);
    }
}

export {
    WebSocketTransport,
    DailyTransport,
    SmallWebRTCTransport,
    GeminiLiveWebsocketTransport,
    OpenAIRealTimeWebRTCTransport
};

export type {
    GeminiLLMServiceOptions,
    OpenAIServiceOptions
};