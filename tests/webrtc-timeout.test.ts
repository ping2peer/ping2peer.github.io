import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebRtcDataChannelTransport } from "../src/providers/WebRtcDataChannelTransport";
import type { DeviceProfile, SignallingProvider, TransportState } from "../src/types";

class FakeDataChannel {
  readyState: RTCDataChannelState = "connecting";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  close = vi.fn(() => { this.readyState = "closed"; });
  send = vi.fn();
}

class FakePeerConnection {
  static latest: FakePeerConnection;
  connectionState: RTCPeerConnectionState = "connecting";
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: RTCSessionDescription | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: { channel: RTCDataChannel }) => void) | null = null;
  close = vi.fn(() => { this.connectionState = "closed"; });

  constructor() { FakePeerConnection.latest = this; }
  async setRemoteDescription(): Promise<void> {}
  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: "answer", sdp: "answer-sdp" }; }
  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
  }
}

const profile = { publicIdentityKey: { kty: "EC" } } as DeviceProfile;
const offer = { type: "offer", sdp: "offer-sdp", publicIdentityKey: { kty: "EC" } } as RTCSessionDescriptionInit;
const signalling = { sendAnswer: vi.fn() } as unknown as SignallingProvider;

describe("WebRTC connection timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function acceptConnection() {
    const transport = new WebRtcDataChannelTransport();
    const states: TransportState[] = [];
    transport.onStateChange((state) => states.push(state));
    await transport.acceptViaSignalling(profile, "remote", offer, signalling);
    const connection = FakePeerConnection.latest;
    const channel = new FakeDataChannel();
    connection.ondatachannel?.({ channel: channel as unknown as RTCDataChannel });
    return { transport, states, connection, channel };
  }

  it("closes a timed-out connection and ignores late channel events", async () => {
    const { transport, states, connection, channel } = await acceptConnection();

    vi.advanceTimersByTime(20_000);

    expect(states).toEqual(["idle", "connecting", "failed"]);
    expect(connection.close).toHaveBeenCalledOnce();
    expect(channel.close).toHaveBeenCalledOnce();
    expect(connection.onconnectionstatechange).toBeNull();
    expect(connection.ondatachannel).toBeNull();
    expect(channel.onopen).toBeNull();
    expect(transport.state).toBe("failed");
  });

  it("keeps an open channel connected after the timeout window", async () => {
    const { transport, connection, channel } = await acceptConnection();
    channel.readyState = "open";
    channel.onopen?.();

    vi.advanceTimersByTime(20_000);

    expect(transport.state).toBe("connected");
    expect(connection.close).not.toHaveBeenCalled();
    expect(channel.close).not.toHaveBeenCalled();
    transport.disconnect();
  });
});
