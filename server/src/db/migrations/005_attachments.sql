-- Documents attached to a task: completion proof, permits, sign-offs, photos.
--
-- Bytes live on disk; only metadata lives here. Putting files in the database
-- bloats every backup, makes streaming awkward, and turns a 20 MB photo into a
-- 20 MB row that some query will eventually SELECT * over.
--
-- `stored_name` is generated server-side and is the only thing ever used to
-- build a path. `original_name` is display only and is never trusted — it is
-- exactly where "../../etc/passwd" arrives.

CREATE TABLE attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- Denormalised so a download can be authorised without joining through tasks.
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_name   TEXT NOT NULL UNIQUE,
  mime_type     TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL CHECK (size_bytes > 0),
  -- What the file is for, so a permit and a photo can be told apart in the UI.
  kind          TEXT NOT NULL DEFAULT 'document'
                  CHECK (kind IN ('document', 'photo', 'proof')),
  note          TEXT,
  uploaded_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX attachments_task_idx ON attachments (task_id, created_at DESC);
CREATE INDEX attachments_project_idx ON attachments (project_id);
