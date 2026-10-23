import type { Chat, ChatId, DeviceProfile, EncryptedMessage, MessageStore, PeerId, TrustedPeer } from "../types";
import { toggleExclusiveReaction } from "../lib/reactions";

const dbName = "ping2peer-v1";
const dbVersion = 1;

type StoreName = "profile" | "trustedPeers" | "chats" | "messages";

export class IndexedDbMessageStore implements MessageStore {
  private dbPromise?: Promise<IDBDatabase>;

  async getProfile(): Promise<DeviceProfile | undefined> {
    return this.get<DeviceProfile>("profile", "local");
  }

  async saveProfile(profile: DeviceProfile): Promise<void> {
    await this.put("profile", profile, "local");
  }

  async listChats(): Promise<Chat[]> {
    const chats = await this.getAll<Chat>("chats");
    return chats.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async saveChat(chat: Chat): Promise<void> {
    const db = await this.db();
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("chats", "readwrite");
      const chats = transaction.objectStore("chats");
      const request = chats.get(chat.id);
      request.onsuccess = () => {
        const existing = request.result as Chat | undefined;
        chats.put({
          ...existing,
          ...chat,
          createdAt: existing?.createdAt ?? chat.createdAt,
          updatedAt: Math.max(existing?.updatedAt ?? 0, chat.updatedAt),
          unreadCount: existing?.unreadCount ?? chat.unreadCount ?? 0
        });
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async incrementUnread(chatId: ChatId): Promise<void> {
    await this.updateUnreadCount(chatId, count => count + 1);
  }

  async markChatRead(chatId: ChatId): Promise<void> {
    await this.updateUnreadCount(chatId, () => 0);
  }

  async getChat(chatId: ChatId): Promise<Chat | undefined> {
    return this.get<Chat>("chats", chatId);
  }

  async listMessages(chatId: ChatId): Promise<EncryptedMessage[]> {
    const messages = await this.getAllFromIndex<EncryptedMessage>("messages", "by-chat", chatId);
    return messages.sort((a, b) => b.sentAt - a.sentAt);
  }

  async saveMessage(message: EncryptedMessage): Promise<void> {
    await this.put("messages", message);
  }

  async toggleMessageReaction(chatId: ChatId, messageId: string, emoji: string, peerId: PeerId): Promise<void> {
    const db = await this.db();
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("messages", "readwrite");
      const messages = transaction.objectStore("messages");
      const request = messages.get(messageId);
      request.onsuccess = () => {
        const message = request.result as EncryptedMessage | undefined;
        if (message?.chatId === chatId) {
          messages.put({
            ...message,
            reactions: toggleExclusiveReaction(message.reactions, emoji, peerId)
          });
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async saveTrustedPeer(peer: TrustedPeer): Promise<void> {
    await this.put("trustedPeers", peer);
  }

  async getTrustedPeer(peerId: PeerId): Promise<TrustedPeer | undefined> {
    return this.get<TrustedPeer>("trustedPeers", peerId);
  }

  async clearChatMessages(chatId: ChatId): Promise<void> {
    const db = await this.db();
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("messages", "readwrite");
      const store = transaction.objectStore("messages");
      const index = store.index("by-chat");
      const request = index.openCursor(chatId);
      request.onerror = () => reject(request.error);
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
    });
  }

  private async updateUnreadCount(chatId: ChatId, update: (count: number) => number): Promise<void> {
    const db = await this.db();
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("chats", "readwrite");
      const chats = transaction.objectStore("chats");
      const request = chats.get(chatId);
      request.onsuccess = () => {
        const chat = request.result as Chat | undefined;
        if (chat) chats.put({ ...chat, unreadCount: update(chat.unreadCount ?? 0) });
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  private async db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, dbVersion);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          this.migrateOrphanedMessages(db).then(() => resolve(db)).catch(() => resolve(db));
        };
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore("profile");
          db.createObjectStore("trustedPeers", { keyPath: "peerId" });
          db.createObjectStore("chats", { keyPath: "id" });
          const messages = db.createObjectStore("messages", { keyPath: "id" });
          messages.createIndex("by-chat", "chatId", { unique: false });
        };
      });
    }
    return this.dbPromise;
  }

  private async get<T>(storeName: StoreName, key: IDBValidKey): Promise<T | undefined> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result as T | undefined);
    });
  }

  private async getAll<T>(storeName: StoreName): Promise<T[]> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result as T[]);
    });
  }

  private async getAllFromIndex<T>(storeName: StoreName, indexName: string, key: IDBValidKey): Promise<T[]> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).index(indexName).getAll(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result as T[]);
    });
  }

  private async put<T>(storeName: StoreName, value: T, key?: IDBValidKey): Promise<void> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = key
        ? db.transaction(storeName, "readwrite").objectStore(storeName).put(value, key)
        : db.transaction(storeName, "readwrite").objectStore(storeName).put(value);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  private async migrateOrphanedMessages(db: IDBDatabase): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("messages", "readwrite");
      const store = transaction.objectStore("messages");
      const request = store.getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const messages = request.result as EncryptedMessage[];
        for (const msg of messages) {
          if (msg.deliveryState === "received") {
            const expectedChatId = `chat_${msg.senderPeerId}`;
            if (msg.chatId !== expectedChatId) {
              msg.chatId = expectedChatId;
              store.put(msg);
            }
          }
        }
        resolve();
      };
    });
  }
}
