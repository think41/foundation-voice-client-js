import { RTVIClientOptions, RTVIMessage } from '@pipecat-ai/client-js';
import { Client } from './client';
import { WebsocketTransport } from './transport/websocket';

export class CAIProvider {
  private _rtviClient: Client;
  private _transport: WebsocketTransport;
  private _isInitialized: boolean = false;
  private _isConnected: boolean = false;
  private _connectionPromise: Promise<void> | null = null;
  private _connectionResolve: (() => void) | null = null;
  private _connectionReject: ((error: Error) => void) | null = null;

  constructor(options: RTVIClientOptions) {
    console.log("[CAIProvider] Initializing with options:", options);
    const baseUrl = options.params.baseUrl;
    if (!baseUrl || typeof baseUrl !== 'string') {
      throw new Error('RTVIClientOptions.params.baseUrl is required and must be a string');
    }
    const wsOptions: { url: string; apiKey?: string } = { url: baseUrl };
    if (typeof options.params.apiKey === 'string') {
      wsOptions.apiKey = options.params.apiKey;
    }
    this._transport = new WebsocketTransport(wsOptions);
    this._rtviClient = new Client({
      ...options,
      transport: this._transport,
      params: {
        ...options.params,
        baseUrl,
        endpoints: {
          ...options.params.endpoints,
          connect: '/connect'
        }
      }
    });
    this._isInitialized = false;
    this._isConnected = false;
  }

  async initialize(): Promise<void> {
    if (this._isInitialized) {
      console.log("[CAIProvider] Already initialized");
      return;
    }

    try {
      console.log("[CAIProvider] Initializing...");
      await this._rtviClient.connect();
      this._isInitialized = true;
      console.log("[CAIProvider] Initialization complete");
    } catch (error) {
      console.error("[CAIProvider] Initialization failed:", error);
      throw error;
    }
  }

  async connect(): Promise<void> {
    if (!this._isInitialized) {
      throw new Error("CAIProvider must be initialized before connecting");
    }

    if (this._isConnected) {
      console.log("[CAIProvider] Already connected");
      return;
    }

    if (this._connectionPromise) {
      console.log("[CAIProvider] Connection already in progress");
      return this._connectionPromise;
    }

    this._connectionPromise = new Promise((resolve, reject) => {
      this._connectionResolve = resolve;
      this._connectionReject = reject;
    });

    try {
      console.log("[CAIProvider] Connecting...");
      
      // Set up event handlers before connecting
      this._rtviClient.on('error', (error: any) => {
        console.error("[CAIProvider] Connection error:", error);
        this._connectionReject?.(error);
      });

      this._rtviClient.on('disconnected', () => {
        console.log("[CAIProvider] Disconnected");
        this._isConnected = false;
      });

      this._rtviClient.on('transportStateChanged', (state: string) => {
        console.log("[CAIProvider] Transport state changed:", state);
        if (state === 'ready') {
          this._isConnected = true;
          this._connectionResolve?.();
        }
      });

      // Wait for transport to be ready before resolving
      const transportReady = new Promise<void>((resolve) => {
        const checkState = () => {
          if (this._transport.state === 'ready') {
            resolve();
          } else {
            setTimeout(checkState, 100);
          }
        };
        checkState();
      });

      await this._rtviClient.connect();
      await transportReady;
      console.log("[CAIProvider] Connection successful");
    } catch (error) {
      console.error("[CAIProvider] Connection failed:", error);
      this._isConnected = false;
      this._connectionReject?.(error as Error);
      throw error;
    } finally {
      this._connectionPromise = null;
      this._connectionResolve = null;
      this._connectionReject = null;
    }
  }

  async disconnect(): Promise<void> {
    if (!this._isConnected) {
      console.log("[CAIProvider] Not connected");
      return;
    }

    try {
      console.log("[CAIProvider] Disconnecting...");
      await this._rtviClient.disconnect();
      this._isConnected = false;
      console.log("[CAIProvider] Disconnection successful");
    } catch (error) {
      console.error("[CAIProvider] Disconnection failed:", error);
      throw error;
    }
  }

  async sendMessage(message: string): Promise<void> {
    if (!this._isConnected) {
      throw new Error("CAIProvider must be connected before sending messages");
    }

    try {
      console.log("[CAIProvider] Sending message:", message);
      const rtviMessage: RTVIMessage = {
        type: 'text',
        data: { text: message },
        id: crypto.randomUUID(),
        label: 'user_message'
      };
      await this._rtviClient.sendMessage(rtviMessage);
      console.log("[CAIProvider] Message sent successfully");
    } catch (error) {
      console.error("[CAIProvider] Failed to send message:", error);
      throw error;
    }
  }

  onMessage(callback: (message: RTVIMessage) => void): void {
    this._rtviClient.on('serverMessage', callback);
  }

  onError(callback: (message: RTVIMessage) => void): void {
    this._rtviClient.on('error', callback);
  }

  onDisconnect(callback: () => void): void {
    this._rtviClient.on('disconnected', callback);
  }

  isConnected(): boolean {
    return this._isConnected;
  }

  isInitialized(): boolean {
    return this._isInitialized;
  }
} 