import { describe, expect, it } from "vitest";
import { normalizeReactions } from "../src/lib/reactions";
import { IndexedDbMessageStore } from "../src/providers/IndexedDbMessageStore";

describe("message reactions", () => {
  it("shows at most one legacy reaction per device", () => {
    expect(normalizeReactions({ "👍": ["alice", "bob"], "❤️": ["alice"] }))
      .toEqual({ "👍": ["bob"], "❤️": ["alice"] });
  });

  it("replaces an earlier reaction, preserves other devices, and toggles the same reaction off", async () => {
    const store = new IndexedDbMessageStore();
    const chatId = "reaction-chat";
    const messageId = "reaction-message";
    await store.saveMessage({
      id: messageId,
      chatId,
      senderPeerId: "alice",
      sentAt: 1,
      ciphertext: "ciphertext",
      nonce: "nonce",
      deliveryState: "received"
    });

    await Promise.all([
      store.toggleMessageReaction(chatId, messageId, "👍", "alice"),
      store.toggleMessageReaction(chatId, messageId, "❤️", "alice"),
      store.toggleMessageReaction(chatId, messageId, "👍", "bob")
    ]);

    let [message] = await store.listMessages(chatId);
    expect(message.reactions).toEqual({ "❤️": ["alice"], "👍": ["bob"] });

    await store.toggleMessageReaction(chatId, messageId, "❤️", "alice");
    [message] = await store.listMessages(chatId);
    expect(message.reactions).toEqual({ "👍": ["bob"] });
  });
});
