-- Tenant tables. Source of truth: the `table_design` sheet (design/table_design.md).
-- Times are INTEGER epoch seconds. Expiry is derived (created_at + N), never stored.
-- Foreign keys point in a circle (user <-> member <-> household), so insert in this order:
--   household (owner_id NULL) -> user (household_id NULL) -> member -> set user.household_id /
--   home_household_id -> set household.owner_id.

-- ---------------------------------------------------------------- tenant_household
CREATE TABLE tenant_household (
  id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (length(id) = 36),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (created_at > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (updated_at > 0),
  owner_id TEXT,
  FOREIGN KEY (id, owner_id) REFERENCES tenant_household_member (household_id, user_id)
) STRICT;

-- ---------------------------------------------------------------- tenant_user
CREATE TABLE tenant_user (
  id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (length(id) = 36),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (created_at > 0),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE
    CHECK (email COLLATE BINARY = lower(trim(email)))
    CHECK (instr(email, '@') > 0)
    CHECK (length(email) <= 254),
  email_verified_at INTEGER CHECK (email_verified_at > 0),
  username TEXT UNIQUE COLLATE NOCASE
    CHECK (username COLLATE BINARY = lower(trim(username)))
    CHECK (length(username) BETWEEN 3 AND 30)
    CHECK (instr(username, ' ') = 0)
    CHECK (instr(username, '@') = 0),
  name TEXT NOT NULL
    CHECK (name COLLATE BINARY = lower(trim(name)))
    CHECK (name <> '')
    CHECK (length(name) <= 100),
  household_id TEXT,
  home_household_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (updated_at > 0),
  FOREIGN KEY (household_id, id) REFERENCES tenant_household_member (household_id, user_id),
  FOREIGN KEY (home_household_id, id) REFERENCES tenant_household_member (household_id, user_id)
) STRICT;
CREATE INDEX tenant_user_household_idx ON tenant_user (household_id);

CREATE TRIGGER tenant_user_email_verified_once
BEFORE UPDATE OF email_verified_at ON tenant_user
WHEN OLD.email_verified_at IS NOT NULL AND NEW.email_verified_at IS NOT OLD.email_verified_at
BEGIN
  SELECT RAISE(ABORT, 'email_verified_at is set once and never changes');
END;

CREATE TRIGGER tenant_user_username_kept
BEFORE UPDATE OF username ON tenant_user
WHEN OLD.username IS NOT NULL AND NEW.username IS NULL AND OLD.email_verified_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'username cannot go back to NULL once the account is verified');
END;

CREATE TRIGGER tenant_user_household_kept
BEFORE UPDATE OF household_id ON tenant_user
WHEN OLD.household_id IS NOT NULL AND NEW.household_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'household_id cannot go back to NULL');
END;

CREATE TRIGGER tenant_user_home_household_rule
BEFORE UPDATE OF home_household_id ON tenant_user
WHEN OLD.home_household_id IS NOT NULL AND NEW.home_household_id IS NOT OLD.home_household_id AND NOT (NEW.household_id IS NEW.home_household_id AND NEW.household_id IS NOT OLD.household_id)
BEGIN
  SELECT RAISE(ABORT, 'home_household_id changes only together with household_id');
END;

CREATE TRIGGER tenant_user_no_restore
BEFORE UPDATE OF is_active ON tenant_user
WHEN OLD.is_active = 0 AND NEW.is_active = 1
BEGIN
  SELECT RAISE(ABORT, 'is_active never goes back to 1');
END;


-- ---------------------------------------------------------------- tenant_household_member
CREATE TABLE tenant_household_member (
  household_id TEXT NOT NULL REFERENCES tenant_household (id),
  user_id TEXT NOT NULL REFERENCES tenant_user (id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (created_at > 0),
  PRIMARY KEY (household_id, user_id)
) STRICT;
CREATE INDEX tenant_household_member_user_idx ON tenant_household_member (user_id);

CREATE TRIGGER tenant_household_member_no_update
BEFORE UPDATE ON tenant_household_member
BEGIN
  SELECT RAISE(ABORT, 'member rows are never updated');
END;

CREATE TRIGGER tenant_household_member_no_delete
BEFORE DELETE ON tenant_household_member
BEGIN
  SELECT RAISE(ABORT, 'member rows are never deleted');
END;


-- ---------------------------------------------------------------- tenant_user_login
CREATE TABLE tenant_user_login (
  id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (length(id) = 36),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (created_at > 0),
  provider TEXT NOT NULL CHECK (provider IN ('password', 'google', 'apple')),
  provider_user_id TEXT NOT NULL CHECK (provider_user_id <> ''),
  user_id TEXT NOT NULL REFERENCES tenant_user (id),
  password_hash TEXT
    CHECK (password_hash <> ''),
  last_login_at INTEGER CHECK (last_login_at > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (updated_at > 0),
  UNIQUE (user_id, provider),
  UNIQUE (provider, provider_user_id),
  CHECK ((provider = 'password' AND password_hash IS NOT NULL) OR (provider <> 'password' AND password_hash IS NULL)),
  CHECK (provider <> 'password' OR provider_user_id = user_id)
) STRICT;

CREATE TRIGGER tenant_user_login_provider_fixed
BEFORE UPDATE OF provider ON tenant_user_login
WHEN NEW.provider IS NOT OLD.provider
BEGIN
  SELECT RAISE(ABORT, 'provider never changes');
END;

CREATE TRIGGER tenant_user_login_user_id_fixed
BEFORE UPDATE OF user_id ON tenant_user_login
WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id never changes');
END;

CREATE TRIGGER tenant_user_login_keep_last
BEFORE DELETE ON tenant_user_login
WHEN (SELECT count(*) FROM tenant_user_login WHERE user_id = OLD.user_id) <= 1
BEGIN
  SELECT RAISE(ABORT, 'cannot delete the last login of a user');
END;


-- ---------------------------------------------------------------- tenant_user_invite
CREATE TABLE tenant_user_invite (
  id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (length(id) = 36),
  household_id TEXT NOT NULL REFERENCES tenant_household (id),
  invited_by TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE
    CHECK (email COLLATE BINARY = lower(trim(email)))
    CHECK (instr(email, '@') > 0),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'cancelled')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (created_at > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (updated_at > 0),
  FOREIGN KEY (household_id, invited_by) REFERENCES tenant_household_member (household_id, user_id)
) STRICT;
CREATE UNIQUE INDEX tenant_user_invite_open_email_uq ON tenant_user_invite (household_id, email) WHERE status = 'open';
CREATE INDEX tenant_user_invite_open_email_idx ON tenant_user_invite (email) WHERE status = 'open';

CREATE TRIGGER tenant_user_invite_household_id_fixed
BEFORE UPDATE OF household_id ON tenant_user_invite
WHEN NEW.household_id IS NOT OLD.household_id
BEGIN
  SELECT RAISE(ABORT, 'household_id never changes');
END;

CREATE TRIGGER tenant_user_invite_inviter_current
BEFORE INSERT ON tenant_user_invite
WHEN (SELECT household_id FROM tenant_user WHERE id = NEW.invited_by) IS NOT NEW.household_id
BEGIN
  SELECT RAISE(ABORT, 'inviter must currently be in this household');
END;

CREATE TRIGGER tenant_user_invite_not_member
BEFORE INSERT ON tenant_user_invite
WHEN EXISTS (SELECT 1 FROM tenant_user WHERE email = NEW.email AND household_id = NEW.household_id)
BEGIN
  SELECT RAISE(ABORT, 'this email is already in the household');
END;

CREATE TRIGGER tenant_user_invite_status_forward
BEFORE UPDATE OF status ON tenant_user_invite
WHEN OLD.status <> 'open' AND NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'invite status only moves away from open');
END;

CREATE TRIGGER tenant_user_invite_accepted_needs_user
BEFORE UPDATE OF status ON tenant_user_invite
WHEN NEW.status = 'accepted' AND OLD.status <> 'accepted' AND NOT EXISTS (SELECT 1 FROM tenant_user WHERE email = OLD.email AND household_id = OLD.household_id)
BEGIN
  SELECT RAISE(ABORT, 'accepted needs a user in this household');
END;

CREATE TRIGGER tenant_user_invite_accepted_expiry
BEFORE UPDATE OF status ON tenant_user_invite
WHEN NEW.status = 'accepted' AND OLD.status <> 'accepted' AND unixepoch() > OLD.created_at + 86400
BEGIN
  SELECT RAISE(ABORT, 'invite expired');
END;


-- ---------------------------------------------------------------- tenant_user_email_verification
CREATE TABLE tenant_user_email_verification (
  id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (length(id) = 36),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (created_at > 0),
  user_id TEXT NOT NULL REFERENCES tenant_user (id),
  email TEXT NOT NULL
    CHECK (email = lower(trim(email)))
    CHECK (instr(email, '@') > 0),
  token_hash TEXT NOT NULL UNIQUE,
  used_at INTEGER CHECK (used_at >= created_at)
) STRICT;
CREATE INDEX tenant_user_email_verification_user_idx ON tenant_user_email_verification (user_id);

CREATE TRIGGER tenant_user_email_verification_user_id_fixed
BEFORE UPDATE OF user_id ON tenant_user_email_verification
WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id never changes');
END;

CREATE TRIGGER tenant_user_email_verification_used_once
BEFORE UPDATE OF used_at ON tenant_user_email_verification
WHEN OLD.used_at IS NOT NULL AND NEW.used_at IS NOT OLD.used_at
BEGIN
  SELECT RAISE(ABORT, 'used_at is set once and never changes');
END;

CREATE TRIGGER tenant_user_email_verification_expiry
BEFORE UPDATE OF used_at ON tenant_user_email_verification
WHEN NEW.used_at > OLD.created_at + 86400
BEGIN
  SELECT RAISE(ABORT, 'link expired');
END;


-- ---------------------------------------------------------------- tenant_user_password_reset
CREATE TABLE tenant_user_password_reset (
  id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (length(id) = 36),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (created_at > 0),
  user_id TEXT NOT NULL REFERENCES tenant_user (id),
  token_hash TEXT NOT NULL UNIQUE,
  used_at INTEGER CHECK (used_at >= created_at)
) STRICT;
CREATE INDEX tenant_user_password_reset_user_idx ON tenant_user_password_reset (user_id);

CREATE TRIGGER tenant_user_password_reset_user_id_fixed
BEFORE UPDATE OF user_id ON tenant_user_password_reset
WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id never changes');
END;

CREATE TRIGGER tenant_user_password_reset_used_once
BEFORE UPDATE OF used_at ON tenant_user_password_reset
WHEN OLD.used_at IS NOT NULL AND NEW.used_at IS NOT OLD.used_at
BEGIN
  SELECT RAISE(ABORT, 'used_at is set once and never changes');
END;

CREATE TRIGGER tenant_user_password_reset_expiry
BEFORE UPDATE OF used_at ON tenant_user_password_reset
WHEN NEW.used_at > OLD.created_at + 3600
BEGIN
  SELECT RAISE(ABORT, 'link expired');
END;


-- ---------------------------------------------------------------- tenant_user_session
CREATE TABLE tenant_user_session (
  id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (length(id) = 36),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (created_at > 0),
  user_id TEXT NOT NULL REFERENCES tenant_user (id),
  refresh_token_hash TEXT NOT NULL UNIQUE CHECK (refresh_token_hash <> ''),
  previous_refresh_token_hash TEXT UNIQUE,
  last_used_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (last_used_at > 0),
  ended_at INTEGER CHECK (ended_at >= created_at)
) STRICT;
CREATE INDEX tenant_user_session_active_idx ON tenant_user_session (user_id) WHERE ended_at IS NULL;

CREATE TRIGGER tenant_user_session_user_id_fixed
BEFORE UPDATE OF user_id ON tenant_user_session
WHEN NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id never changes');
END;

CREATE TRIGGER tenant_user_session_ended_once
BEFORE UPDATE OF ended_at ON tenant_user_session
WHEN OLD.ended_at IS NOT NULL AND NEW.ended_at IS NOT OLD.ended_at
BEGIN
  SELECT RAISE(ABORT, 'ended_at is set once and never changes');
END;

