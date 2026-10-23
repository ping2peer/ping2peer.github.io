export type PeerId = string;
export type ChatId = string;

export type DeviceProfile = {
  peerId: PeerId;
  displayName: string;
  deviceName: string;
  publicIdentityKey: JsonWebKey;
  privateIdentityKey: JsonWebKey;
  createdAt: number;
};

export type TrustedPeer = {
  peerId: PeerId;
  displayName: string;
  deviceName: string;
  publicIdentityKey: JsonWebKey;
  firstTrustedAt: number;
  lastSeenAt: number;
};

export type Chat = {
  id: ChatId;
  peerId: PeerId;
  title: string;
  createdAt: number;
  updatedAt: number;
  unreadCount?: number;
};

export type EncryptedMessage = {
  id: string;
  chatId: ChatId;
  senderPeerId: PeerId;
  sentAt: number;
  ciphertext: string;
  nonce: string;
  deliveryState: "sending" | "sent" | "received" | "failed";
  replyToId?: string;
  reactions?: Record<string, string[]>; // mapping emoji -> list of peerIds
};

export type PlainMessage = {
  id: string;
  chatId: ChatId;
  senderPeerId: PeerId;
  sentAt: number;
  body: string;
  deliveryState: EncryptedMessage["deliveryState"];
  replyToId?: string;
  reactions?: Record<string, string[]>; // mapping emoji -> list of peerIds
};

export type FallbackChatKey = {
  kind: "fallback";
  keyMaterial: string;
};

export type ChatKey = CryptoKey | FallbackChatKey;

export type PairingPayload = {
  version: 1;
  role: "invite" | "answer";
  sessionId: string;
  peer: {
    peerId: PeerId;
    displayName: string;
    deviceName: string;
    publicIdentityKey: JsonWebKey;
  };
  signal: RTCSessionDescriptionInit;
  capabilities: {
    text: true;
    appEncryption: "ecdh-p256-aes-gcm";
    discovery: "manual";
  };
};

export type ChatEnvelope =
  | {
      type: "chat-message";
      message: EncryptedMessage;
    }
  | {
      type: "peer-ready";
      peerId: PeerId;
    }
  | {
      type: "ping";
    }
  | {
      type: "pong";
    }
  | {
      type: "reaction";
      messageId: string;
      reaction: string;
      senderPeerId: PeerId;
    };

export interface CryptoProvider {
  createProfile(displayName: string, deviceName: string): Promise<DeviceProfile>;
  importIdentity(profile: DeviceProfile): Promise<CryptoKeyPair>;
  deriveChatKey(privateKey: JsonWebKey, peerPublicKey: JsonWebKey): Promise<ChatKey>;
  encryptText(key: ChatKey, text: string): Promise<{ ciphertext: string; nonce: string }>;
  decryptText(key: ChatKey, ciphertext: string, nonce: string): Promise<string>;
}

export interface MessageStore {
  getProfile(): Promise<DeviceProfile | undefined>;
  saveProfile(profile: DeviceProfile): Promise<void>;
  listChats(): Promise<Chat[]>;
  saveChat(chat: Chat): Promise<void>;
  incrementUnread(chatId: ChatId): Promise<void>;
  markChatRead(chatId: ChatId): Promise<void>;
  getChat(chatId: ChatId): Promise<Chat | undefined>;
  listMessages(chatId: ChatId): Promise<EncryptedMessage[]>;
  saveMessage(message: EncryptedMessage): Promise<void>;
  toggleMessageReaction(chatId: ChatId, messageId: string, emoji: string, peerId: PeerId): Promise<void>;
  saveTrustedPeer(peer: TrustedPeer): Promise<void>;
  getTrustedPeer(peerId: PeerId): Promise<TrustedPeer | undefined>;
  clearChatMessages(chatId: ChatId): Promise<void>;
}

export type TransportState = "idle" | "connecting" | "connected" | "failed" | "closed";

export interface PeerTransport {
  readonly state: TransportState;
  createInvite(profile: DeviceProfile): Promise<PairingPayload>;
  acceptInvite(profile: DeviceProfile, invite: PairingPayload): Promise<PairingPayload>;
  applyAnswer(answer: PairingPayload): Promise<void>;
  send(envelope: ChatEnvelope): void;
  disconnect(): void;
  onMessage(handler: (envelope: ChatEnvelope) => void): () => void;
  onStateChange(handler: (state: TransportState) => void): () => void;
}

export interface DiscoveryProvider {
  encodePayload(payload: PairingPayload): string;
  decodePayload(text: string): PairingPayload;
}

// ---------------------------------------------------------------------------
// Signalling protocol types
// ---------------------------------------------------------------------------

export type DiscoveredPeer = {
  peerId: PeerId;
  displayName: string;
  deviceName: string;
};

export type ConnectionRequest = {
  from: DiscoveredPeer;
  timestamp: number;
};

// Client → Server messages
export type SignalClientMessage =
  | { type: "register"; peerId: string; displayName: string; deviceName: string }
  | { type: "connect-request"; to: string }
  | { type: "connect-accepted"; to: string }
  | { type: "connect-rejected"; to: string }
  | { type: "webrtc-offer"; to: string; signal: RTCSessionDescriptionInit }
  | { type: "webrtc-answer"; to: string; signal: RTCSessionDescriptionInit };

// Server → Client messages
export type SignalServerMessage =
  | { type: "peers"; peers: DiscoveredPeer[] }
  | { type: "register-success"; peers: DiscoveredPeer[] }
  | { type: "peer-joined"; peer: DiscoveredPeer }
  | { type: "peer-left"; peerId: string }
  | { type: "connect-request"; from: DiscoveredPeer }
  | { type: "connect-accepted"; from: string }
  | { type: "connect-rejected"; from: string }
  | { type: "webrtc-offer"; from: string; signal: RTCSessionDescriptionInit }
  | { type: "webrtc-answer"; from: string; signal: RTCSessionDescriptionInit }
  | { type: "error"; message: string };

export type SignalConnectionState = "disconnected" | "connecting" | "connected";

export interface SignallingProvider {
  readonly connectionState: SignalConnectionState;
  connect(serverUrl: string, profile: DeviceProfile): void;
  disconnect(): void;
  readonly peers: DiscoveredPeer[];
  requestConnection(peerId: PeerId): void;
  acceptConnection(peerId: PeerId): void;
  rejectConnection(peerId: PeerId): void;
  sendOffer(peerId: PeerId, signal: RTCSessionDescriptionInit): void;
  sendAnswer(peerId: PeerId, signal: RTCSessionDescriptionInit): void;
  onPeersChanged(handler: (peers: DiscoveredPeer[]) => void): () => void;
  onConnectionRequest(handler: (request: ConnectionRequest) => void): () => void;
  onConnectionAccepted(handler: (fromPeerId: PeerId) => void): () => void;
  onConnectionRejected(handler: (fromPeerId: PeerId) => void): () => void;
  onWebRtcOffer(handler: (fromPeerId: PeerId, signal: RTCSessionDescriptionInit) => void): () => void;
  onWebRtcAnswer(handler: (fromPeerId: PeerId, signal: RTCSessionDescriptionInit) => void): () => void;
  onConnectionStateChange(handler: (state: SignalConnectionState) => void): () => void;
}
