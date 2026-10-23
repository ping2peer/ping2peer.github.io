import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IndexedDbMessageStore } from "../src/providers/IndexedDbMessageStore";
import { WebCryptoProvider } from "../src/providers/WebCryptoProvider";
import { App } from "../src/ui/App";
import type { ChatEnvelope } from "../src/types";

const relayMock = vi.hoisted(() => ({
  instances: [] as Array<{ goOffline: () => void; receive: (envelope: ChatEnvelope) => void }>
}));

vi.mock("../src/providers/SignallingDiscoveryProvider", () => ({
  WebSocketSignallingProvider: class {
    connectionState = "disconnected";
    connect() {}
    disconnect() {}
    onConnectionStateChange(handler: (state: string) => void) { handler(this.connectionState); return () => {}; }
    onPeersChanged(handler: (peers: unknown[]) => void) { handler([]); return () => {}; }
    onConnectionRequest() { return () => {}; }
    onConnectionAccepted() { return () => {}; }
    onConnectionRejected() { return () => {}; }
    onWebRtcOffer() { return () => {}; }
    onWebRtcAnswer() { return () => {}; }
  }
}));

vi.mock("../src/providers/RelayTextTransport", () => ({
  RelayTextTransport: class {
    state = "idle";
    private handlers = new Set<(state: string) => void>();
    private messageHandlers = new Set<(envelope: ChatEnvelope) => void>();

    constructor() { relayMock.instances.push(this); }
    onStateChange(handler: (state: string) => void) {
      this.handlers.add(handler);
      handler(this.state);
      return () => this.handlers.delete(handler);
    }
    onMessage(handler: (envelope: ChatEnvelope) => void) {
      this.messageHandlers.add(handler);
      return () => this.messageHandlers.delete(handler);
    }
    receive(envelope: ChatEnvelope) {
      this.messageHandlers.forEach(handler => handler(envelope));
    }
    goOffline() {
      this.state = "closed";
      this.handlers.forEach(handler => handler(this.state));
    }
    disconnect() { this.goOffline(); }
  }
}));

describe("offline chat history", () => {
  it("keeps saved messages visible when the peer transport closes", async () => {
    const store = new IndexedDbMessageStore();
    const crypto = new WebCryptoProvider();
    const me = await crypto.createProfile("Me", "My device");
    const peer = await crypto.createProfile("Alex", "Phone");
    const chatId = `chat_${peer.peerId}`;
    const key = await crypto.deriveChatKey(me.privateIdentityKey, peer.publicIdentityKey);
    const encrypted = await crypto.encryptText(key, "History survives disconnect");

    await store.saveProfile(me);
    await store.saveTrustedPeer({
      peerId: peer.peerId,
      displayName: peer.displayName,
      deviceName: peer.deviceName,
      publicIdentityKey: peer.publicIdentityKey,
      firstTrustedAt: 1,
      lastSeenAt: 1
    });
    await store.saveChat({ id: chatId, peerId: peer.peerId, title: "Alex - Phone", createdAt: 1, updatedAt: 1 });
    await store.saveMessage({
      id: "saved-message",
      chatId,
      senderPeerId: peer.peerId,
      sentAt: 2,
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      deliveryState: "received"
    });

    render(<App />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Chats" }))[0]);
    fireEvent.click(await screen.findByText("Alex - Phone"));
    expect(await screen.findByText("History survives disconnect")).toBeInTheDocument();

    act(() => relayMock.instances.at(-1)?.goOffline());
    await waitFor(() => expect(screen.getByText("offline")).toBeInTheDocument());
    expect(screen.getByText("History survives disconnect")).toBeInTheDocument();
  });

  it("counts incoming messages outside the chat and clears the count when opened", async () => {
    const store = new IndexedDbMessageStore();
    const crypto = new WebCryptoProvider();
    const me = await crypto.createProfile("Me", "Laptop");
    const peer = await crypto.createProfile("Taylor", "Tablet");
    const chatId = `chat_${peer.peerId}`;
    const key = await crypto.deriveChatKey(me.privateIdentityKey, peer.publicIdentityKey);

    await store.saveProfile(me);
    await store.saveTrustedPeer({
      peerId: peer.peerId,
      displayName: peer.displayName,
      deviceName: peer.deviceName,
      publicIdentityKey: peer.publicIdentityKey,
      firstTrustedAt: 1,
      lastSeenAt: 1
    });
    await store.saveChat({ id: chatId, peerId: peer.peerId, title: "Taylor - Tablet", createdAt: 1, updatedAt: 1 });

    const view = render(<App />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Chats" }))[0]);
    fireEvent.click(await screen.findByText("Taylor - Tablet"));
    await waitFor(async () => expect((await store.getChat(chatId))?.unreadCount).toBe(0));
    fireEvent.click(await screen.findByRole("button", { name: "Back" }));

    const transport = relayMock.instances.at(-1);
    for (const [index, body] of ["First new message", "Second new message"].entries()) {
      const encrypted = await crypto.encryptText(key, body);
      act(() => transport?.receive({
        type: "chat-message",
        message: {
          id: `incoming-${index}`,
          chatId,
          senderPeerId: peer.peerId,
          sentAt: index + 3,
          ciphertext: encrypted.ciphertext,
          nonce: encrypted.nonce,
          deliveryState: "sent"
        }
      }));
      await screen.findByText(`${index + 1} new ${index === 0 ? "message" : "messages"}`);
    }

    expect(screen.getAllByRole("button", { name: "Chats, 2 new messages" })).toHaveLength(2);
    expect((await store.getChat(chatId))?.unreadCount).toBe(2);

    view.unmount();
    render(<App />);
    expect(await screen.findAllByRole("button", { name: "Chats, 2 new messages" })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Chats, 2 new messages" })[0]);
    expect(screen.getByText("2 new messages")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Taylor - Tablet"));

    expect(await screen.findByText("First new message")).toBeInTheDocument();
    expect(await screen.findByText("Second new message")).toBeInTheDocument();
    await waitFor(async () => expect((await store.getChat(chatId))?.unreadCount).toBe(0));
    await waitFor(() => expect(screen.queryByText("2 new messages")).not.toBeInTheDocument());
  });
});
