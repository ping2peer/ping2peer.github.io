import type {
  ConnectionRequest,
  DeviceProfile,
  DiscoveredPeer,
  PeerId,
  SignalClientMessage,
  SignalConnectionState,
  SignallingProvider,
  SignalServerMessage,
} from "../types";

export class WebSocketSignallingProvider implements SignallingProvider {
  private socket?: WebSocket;
  private currentPeers: DiscoveredPeer[] = [];
  private state: SignalConnectionState = "disconnected";
  private reconnectTimeout?: number;
  private profile?: DeviceProfile;
  private serverUrl?: string;

  private peersHandlers = new Set<(peers: DiscoveredPeer[]) => void>();
  private requestHandlers = new Set<(request: ConnectionRequest) => void>();
  private acceptedHandlers = new Set<(fromPeerId: PeerId) => void>();
  private rejectedHandlers = new Set<(fromPeerId: PeerId) => void>();
  private offerHandlers = new Set<(fromPeerId: PeerId, signal: RTCSessionDescriptionInit) => void>();
  private answerHandlers = new Set<(fromPeerId: PeerId, signal: RTCSessionDescriptionInit) => void>();
  private stateHandlers = new Set<(state: SignalConnectionState) => void>();

  get connectionState(): SignalConnectionState {
    return this.state;
  }

  get peers(): DiscoveredPeer[] {
    return this.currentPeers;
  }

  connect(serverUrl: string, profile: DeviceProfile): void {
    if (this.state === "connected" && this.serverUrl === serverUrl) return;

    this.serverUrl = serverUrl;
    this.profile = profile;
    this.doConnect();
  }

  private doConnect(): void {
    if (!this.serverUrl || !this.profile) return;

    this.disconnect();
    this.setState("connecting");

    try {
      this.socket = new WebSocket(this.serverUrl);

      this.socket.onopen = () => {
        this.setState("connected");
        this.send({
          type: "register",
          peerId: this.profile!.peerId,
          displayName: this.profile!.displayName,
          deviceName: this.profile!.deviceName,
        });
      };

      this.socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as SignalServerMessage;
        this.handleMessage(message);
      };

      this.socket.onclose = () => {
        this.setState("disconnected");
        this.currentPeers = [];
        this.emitPeers();
        this.scheduleReconnect();
      };

      this.socket.onerror = () => {
        // onerror will typically be followed by onclose
      };
    } catch (err) {
      this.setState("disconnected");
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    if (this.reconnectTimeout) {
      window.clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }
    if (this.socket) {
      this.socket.onclose = null; // Prevent reconnect
      this.socket.close();
      this.socket = undefined;
    }
    this.setState("disconnected");
    this.currentPeers = [];
    this.emitPeers();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;
    this.reconnectTimeout = window.setTimeout(() => {
      this.reconnectTimeout = undefined;
      this.doConnect();
    }, 5000);
  }

  requestConnection(peerId: PeerId): void {
    this.send({ type: "connect-request", to: peerId });
  }

  acceptConnection(peerId: PeerId): void {
    this.send({ type: "connect-accepted", to: peerId });
  }

  rejectConnection(peerId: PeerId): void {
    this.send({ type: "connect-rejected", to: peerId });
  }

  sendOffer(peerId: PeerId, signal: RTCSessionDescriptionInit): void {
    this.send({ type: "webrtc-offer", to: peerId, signal });
  }

  sendAnswer(peerId: PeerId, signal: RTCSessionDescriptionInit): void {
    this.send({ type: "webrtc-answer", to: peerId, signal });
  }

  private send(message: SignalClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    } else {
      console.warn("Signalling server not connected, dropped message:", message);
    }
  }

  private handleMessage(message: SignalServerMessage): void {
    console.log("[Signal] Received message:", message.type, message);
    switch (message.type) {
      case "peers":
      case "register-success":
        this.currentPeers = message.peers;
        this.emitPeers();
        break;
      case "peer-joined":
        if (!this.currentPeers.some((p) => p.peerId === message.peer.peerId)) {
          this.currentPeers = [...this.currentPeers, message.peer];
          this.emitPeers();
        }
        break;
      case "peer-left":
        this.currentPeers = this.currentPeers.filter((p) => p.peerId !== message.peerId);
        this.emitPeers();
        break;
      case "connect-request":
        console.log("[Signal] Dispatching connect-request to handlers:", this.requestHandlers.size);
        this.requestHandlers.forEach((h) => h({ from: message.from, timestamp: Date.now() }));
        break;
      case "connect-accepted":
        this.acceptedHandlers.forEach((h) => h(message.from));
        break;
      case "connect-rejected":
        this.rejectedHandlers.forEach((h) => h(message.from));
        break;
      case "webrtc-offer":
        this.offerHandlers.forEach((h) => h(message.from, message.signal));
        break;
      case "webrtc-answer":
        this.answerHandlers.forEach((h) => h(message.from, message.signal));
        break;
      case "error":
        console.error("Signalling server error:", message.message);
        break;
    }
  }

  private emitPeers(): void {
    this.peersHandlers.forEach((h) => h(this.currentPeers));
  }

  private setState(state: SignalConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.stateHandlers.forEach((h) => h(state));
    }
  }

  onPeersChanged(handler: (peers: DiscoveredPeer[]) => void): () => void {
    this.peersHandlers.add(handler);
    handler(this.currentPeers);
    return () => this.peersHandlers.delete(handler);
  }

  onConnectionRequest(handler: (request: ConnectionRequest) => void): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  onConnectionAccepted(handler: (fromPeerId: PeerId) => void): () => void {
    this.acceptedHandlers.add(handler);
    return () => this.acceptedHandlers.delete(handler);
  }

  onConnectionRejected(handler: (fromPeerId: PeerId) => void): () => void {
    this.rejectedHandlers.add(handler);
    return () => this.rejectedHandlers.delete(handler);
  }

  onWebRtcOffer(handler: (fromPeerId: PeerId, signal: RTCSessionDescriptionInit) => void): () => void {
    this.offerHandlers.add(handler);
    return () => this.offerHandlers.delete(handler);
  }

  onWebRtcAnswer(handler: (fromPeerId: PeerId, signal: RTCSessionDescriptionInit) => void): () => void {
    this.answerHandlers.add(handler);
    return () => this.answerHandlers.delete(handler);
  }

  onConnectionStateChange(handler: (state: SignalConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    handler(this.state);
    return () => this.stateHandlers.delete(handler);
  }
}
