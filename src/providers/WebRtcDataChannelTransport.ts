import { createId } from "../lib/encoding";
import type {
  ChatEnvelope,
  DeviceProfile,
  PairingPayload,
  PeerTransport,
  SignallingProvider,
  TransportState
} from "../types";

type MessageHandler = (envelope: ChatEnvelope) => void;
type StateHandler = (state: TransportState) => void;

const rtcConfig: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ],
  iceCandidatePoolSize: 4
};

const iceGatheringTimeoutMs = 10000;

export class WebRtcDataChannelTransport implements PeerTransport {
  private connection?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private messageHandlers = new Set<MessageHandler>();
  private stateHandlers = new Set<StateHandler>();
  private sessionId = createId("session");
  private currentState: TransportState = "idle";
  private heartbeatInterval?: number;
  private disconnectedTimeout?: number;
  private connectionTimeout?: number;

  get state(): TransportState {
    return this.currentState;
  }

  async createInvite(profile: DeviceProfile): Promise<PairingPayload> {
    this.reset();
    this.connection = this.createConnection();
    this.channel = this.connection.createDataChannel("ping2peer-text", { ordered: true });
    this.bindChannel(this.channel);
    const offer = await this.connection.createOffer();
    await this.connection.setLocalDescription(offer);
    await this.waitForIceGathering(this.connection);
    this.setState("connecting");

    return this.createPayload("invite", profile, this.connection.localDescription!);
  }

  async acceptInvite(profile: DeviceProfile, invite: PairingPayload): Promise<PairingPayload> {
    this.reset(invite.sessionId);
    this.connection = this.createConnection();
    this.connection.ondatachannel = (event) => {
      this.channel = event.channel;
      this.bindChannel(event.channel);
    };
    await this.connection.setRemoteDescription(invite.signal);
    const answer = await this.connection.createAnswer();
    await this.connection.setLocalDescription(answer);
    await this.waitForIceGathering(this.connection);
    this.setState("connecting");

    return this.createPayload("answer", profile, this.connection.localDescription!);
  }

  async applyAnswer(answer: PairingPayload): Promise<void> {
    if (!this.connection) {
      throw new Error("Create an invite before applying an answer.");
    }
    await this.connection.setRemoteDescription(answer.signal);
  }

  async connectViaSignalling(
    profile: DeviceProfile,
    targetPeerId: string,
    signallingProvider: SignallingProvider
  ): Promise<JsonWebKey> {
    this.reset();
    this.connection = this.createConnection();
    this.channel = this.connection.createDataChannel("ping2peer-text", { ordered: true });
    this.bindChannel(this.channel);
    const offer = await this.connection.createOffer();
    await this.connection.setLocalDescription(offer);
    await this.waitForIceGathering(this.connection);
    this.setState("connecting");

    const signalWithKey = {
      type: this.connection.localDescription!.type,
      sdp: this.connection.localDescription!.sdp,
      publicIdentityKey: profile.publicIdentityKey
    };

    signallingProvider.sendOffer(targetPeerId, signalWithKey as any);
    this.startConnectionTimeout();

    return new Promise((resolve, reject) => {
      let settled = false;
      const off = signallingProvider.onWebRtcAnswer((fromPeerId, signal) => {
        if (fromPeerId === targetPeerId) {
          off();
          this.connection!.setRemoteDescription({ type: signal.type, sdp: signal.sdp })
            .then(() => {
              const remoteKey = (signal as any).publicIdentityKey;
              if (!remoteKey) {
                settled = true;
                window.clearTimeout(timeout);
                reject(new Error("Remote peer did not send public identity key"));
              } else {
                settled = true;
                window.clearTimeout(timeout);
                resolve(remoteKey);
              }
            })
            .catch((error) => {
              settled = true;
              window.clearTimeout(timeout);
              reject(error);
            });
        }
      });
      // Set a timeout to prevent hanging forever if peer disconnects
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error("Timeout waiting for WebRTC answer"));
      }, 15000);
    });
  }

  async acceptViaSignalling(
    profile: DeviceProfile,
    targetPeerId: string,
    offerSignal: RTCSessionDescriptionInit,
    signallingProvider: SignallingProvider
  ): Promise<JsonWebKey> {
    this.reset();
    this.connection = this.createConnection();
    this.connection.ondatachannel = (event) => {
      this.channel = event.channel;
      this.bindChannel(event.channel);
    };

    const remoteKey = (offerSignal as any).publicIdentityKey;
    if (!remoteKey) {
      throw new Error("Offer signal is missing public identity key");
    }

    await this.connection.setRemoteDescription({ type: offerSignal.type, sdp: offerSignal.sdp });
    const answer = await this.connection.createAnswer();
    await this.connection.setLocalDescription(answer);
    await this.waitForIceGathering(this.connection);
    this.setState("connecting");

    const signalWithKey = {
      type: this.connection.localDescription!.type,
      sdp: this.connection.localDescription!.sdp,
      publicIdentityKey: profile.publicIdentityKey
    };

    signallingProvider.sendAnswer(targetPeerId, signalWithKey as any);
    this.startConnectionTimeout();

    return remoteKey;
  }

  send(envelope: ChatEnvelope): void {
    if (this.channel?.readyState !== "open") {
      throw new Error("Peer connection is not open.");
    }
    this.channel.send(JSON.stringify(envelope));
  }

  disconnect(): void {
    this.reset();
    this.setState("closed");
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStateChange(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    handler(this.currentState);
    return () => this.stateHandlers.delete(handler);
  }

  private createConnection(): RTCPeerConnection {
    const connection = new RTCPeerConnection(rtcConfig);
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "connected") {
        this.clearDisconnectedTimeout();
        this.setState(this.channel?.readyState === "open" ? "connected" : "connecting");
      }
      if (connection.connectionState === "connecting" || connection.connectionState === "new") {
        this.clearDisconnectedTimeout();
        this.setState("connecting");
      }
      if (connection.connectionState === "disconnected") {
        this.setState("connecting");
        this.disconnectedTimeout ??= window.setTimeout(() => {
          this.disconnectedTimeout = undefined;
          if (this.connection?.connectionState === "disconnected") {
            this.setState("failed");
          }
        }, 8000);
      }
      if (connection.connectionState === "failed") {
        this.clearDisconnectedTimeout();
        this.setState("failed");
      }
      if (connection.connectionState === "closed") {
        this.clearDisconnectedTimeout();
        this.setState("closed");
      }
    };
    return connection;
  }

  private bindChannel(channel: RTCDataChannel): void {
    channel.onopen = () => {
      this.clearDisconnectedTimeout();
      this.clearConnectionTimeout();
      this.setState("connected");
      this.send({ type: "peer-ready", peerId: "remote" });
      this.startHeartbeat();
    };
    channel.onclose = () => {
      this.stopHeartbeat();
      this.setState("closed");
    };
    channel.onerror = () => {
      this.stopHeartbeat();
      this.setState("failed");
    };
    channel.onmessage = (event) => {
      const envelope = JSON.parse(String(event.data)) as ChatEnvelope;
      if (envelope.type === "ping") {
        this.send({ type: "pong" });
        return;
      }
      if (envelope.type === "pong") {
        return;
      }
      this.messageHandlers.forEach((handler) => handler(envelope));
    };
  }

  private createPayload(role: PairingPayload["role"], profile: DeviceProfile, signal: RTCSessionDescription): PairingPayload {
    return {
      version: 1,
      role,
      sessionId: this.sessionId,
      peer: {
        peerId: profile.peerId,
        displayName: profile.displayName,
        deviceName: profile.deviceName,
        publicIdentityKey: profile.publicIdentityKey
      },
      signal: signal.toJSON(),
      capabilities: {
        text: true,
        appEncryption: "ecdh-p256-aes-gcm",
        discovery: "manual"
      }
    };
  }

  private async waitForIceGathering(connection: RTCPeerConnection): Promise<void> {
    if (connection.iceGatheringState === "complete") return;
    await new Promise<void>((resolve) => {
      const timeout = window.setTimeout(resolve, iceGatheringTimeoutMs);
      connection.addEventListener("icegatheringstatechange", () => {
        if (connection.iceGatheringState === "complete") {
          window.clearTimeout(timeout);
          resolve();
        }
      });
    });
  }

  private reset(sessionId = createId("session")): void {
    this.stopHeartbeat();
    this.clearDisconnectedTimeout();
    this.clearConnectionTimeout();
    if (this.channel) {
      this.channel.onopen = null;
      this.channel.onclose = null;
      this.channel.onerror = null;
      this.channel.onmessage = null;
      this.channel.close();
    }
    if (this.connection) {
      this.connection.onconnectionstatechange = null;
      this.connection.ondatachannel = null;
      this.connection.close();
    }
    this.channel = undefined;
    this.connection = undefined;
    this.sessionId = sessionId;
    this.currentState = "idle";
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = window.setInterval(() => {
      if (this.channel?.readyState === "open") {
        try {
          this.send({ type: "ping" });
        } catch (err) {
          console.warn("[WebRTC] Failed to send heartbeat ping:", err);
        }
      }
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      window.clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  private clearDisconnectedTimeout(): void {
    if (this.disconnectedTimeout) {
      window.clearTimeout(this.disconnectedTimeout);
      this.disconnectedTimeout = undefined;
    }
  }

  private startConnectionTimeout(): void {
    this.clearConnectionTimeout();
    this.connectionTimeout = window.setTimeout(() => {
      if (this.currentState !== "connected") {
        this.reset();
        this.setState("failed");
      }
    }, 20000);
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimeout) {
      window.clearTimeout(this.connectionTimeout);
      this.connectionTimeout = undefined;
    }
  }

  private setState(state: TransportState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.stateHandlers.forEach((handler) => handler(state));
  }
}
