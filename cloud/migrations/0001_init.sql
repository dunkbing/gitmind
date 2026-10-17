-- Accounts, workspaces and access. Notes themselves live in each workspace's
-- git repository and Durable Object, not here.
CREATE TABLE users (
	id         TEXT PRIMARY KEY,
	github_id  INTEGER NOT NULL UNIQUE,
	login      TEXT NOT NULL,
	name       TEXT,
	avatar_url TEXT,
	created_at INTEGER NOT NULL
);

CREATE TABLE workspaces (
	id         TEXT PRIMARY KEY,
	slug       TEXT NOT NULL UNIQUE, -- in URLs and MCP tool calls
	name       TEXT NOT NULL,
	kind       TEXT NOT NULL CHECK (kind IN ('personal', 'team')),
	repo       TEXT NOT NULL,        -- git repository name
	created_by TEXT NOT NULL REFERENCES users (id),
	created_at INTEGER NOT NULL
);

CREATE TABLE members (
	workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	user_id      TEXT NOT NULL REFERENCES users (id),
	role         TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
	created_at   INTEGER NOT NULL,
	PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX members_user ON members (user_id);

CREATE TABLE invites (
	code         TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	role         TEXT NOT NULL CHECK (role IN ('admin', 'member')),
	created_by   TEXT NOT NULL REFERENCES users (id),
	created_at   INTEGER NOT NULL,
	expires_at   INTEGER NOT NULL
);

-- Web sessions; id is the SHA-256 of the cookie value.
CREATE TABLE sessions (
	id         TEXT PRIMARY KEY,
	user_id    TEXT NOT NULL REFERENCES users (id),
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
