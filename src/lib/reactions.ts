export type Reactions = Record<string, string[]>;

export function normalizeReactions(reactions?: Reactions): Reactions {
  const lastEmojiByPeer = new Map<string, string>();
  for (const [emoji, peerIds] of Object.entries(reactions ?? {})) {
    for (const peerId of peerIds) lastEmojiByPeer.set(peerId, emoji);
  }

  const normalized: Reactions = Object.create(null);
  for (const [peerId, emoji] of lastEmojiByPeer) {
    (normalized[emoji] ??= []).push(peerId);
  }
  return normalized;
}

export function toggleExclusiveReaction(reactions: Reactions | undefined, emoji: string, peerId: string): Reactions {
  const alreadySelected = reactions?.[emoji]?.includes(peerId) ?? false;
  const next = normalizeReactions(reactions);

  for (const [existingEmoji, peerIds] of Object.entries(next)) {
    const others = peerIds.filter(id => id !== peerId);
    if (others.length) next[existingEmoji] = others;
    else delete next[existingEmoji];
  }

  if (!alreadySelected) (next[emoji] ??= []).push(peerId);
  return next;
}
