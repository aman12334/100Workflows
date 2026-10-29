-- Chat conversations. Message content is user/assistant text only; no secrets are ever stored.
CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content          TEXT NOT NULL,
  -- Assistant replies keep their verified workflow references, recommendations and usage as JSON.
  reply_json       TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);

CREATE INDEX messages_by_conversation ON messages (conversation_id, seq);
CREATE INDEX conversations_by_recency ON conversations (updated_at DESC);
