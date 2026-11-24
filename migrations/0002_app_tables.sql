-- App tables. Source of truth: the `table_design` sheet (design/table_design.md).
-- Every table except app_household_setting carries the shared columns
-- (id, created_at, created_by, household_id, is_active, updated_at, updated_by).
-- Soft delete only: is_active goes 1 -> 0, never back.

-- ---------------------------------------------------------------- app_financial_account
CREATE TABLE app_financial_account (
  id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (length(id) = 36),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (created_at > 0),
  created_by TEXT NOT NULL,
  household_id TEXT NOT NULL REFERENCES tenant_household (id),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (updated_at > 0),
  updated_by TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE
    CHECK (name <> '' AND name COLLATE BINARY = trim(name))
    CHECK (length(name) <= 60),
  type TEXT NOT NULL CHECK (type IN ('credit_card', 'saving_account', 'bank_account')),
  target_saving INTEGER
    CHECK ((type = 'saving_account' AND target_saving IS NOT NULL AND target_saving >= 0) OR (type <> 'saving_account' AND target_saving IS NULL)),
  credit_limit INTEGER
    CHECK ((type = 'credit_card' AND credit_limit IS NOT NULL AND credit_limit > 0) OR (type <> 'credit_card' AND credit_limit IS NULL)),
  bill_day INTEGER
    CHECK ((type = 'credit_card' AND bill_day IS NOT NULL AND bill_day BETWEEN 0 AND 31) OR (type <> 'credit_card' AND bill_day IS NULL)),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, created_by) REFERENCES tenant_household_member (household_id, user_id),
  FOREIGN KEY (household_id, updated_by) REFERENCES tenant_household_member (household_id, user_id)
) STRICT;
CREATE UNIQUE INDEX app_financial_account_name_uq ON app_financial_account (household_id, name) WHERE is_active = 1;

CREATE TRIGGER app_financial_account_created_by_current
BEFORE INSERT ON app_financial_account
WHEN (SELECT household_id FROM tenant_user WHERE id = NEW.created_by) IS NOT NEW.household_id
BEGIN
  SELECT RAISE(ABORT, 'created_by must currently be in this household');
END;

CREATE TRIGGER app_financial_account_updated_by_current
BEFORE UPDATE ON app_financial_account
WHEN (SELECT household_id FROM tenant_user WHERE id = NEW.updated_by) IS NOT NEW.household_id
BEGIN
  SELECT RAISE(ABORT, 'updated_by must currently be in this household');
END;

CREATE TRIGGER app_financial_account_household_fixed
BEFORE UPDATE OF household_id ON app_financial_account
WHEN NEW.household_id IS NOT OLD.household_id
BEGIN
  SELECT RAISE(ABORT, 'household_id never changes');
END;

CREATE TRIGGER app_financial_account_no_restore
BEFORE UPDATE OF is_active ON app_financial_account
WHEN OLD.is_active = 0 AND NEW.is_active = 1
BEGIN
  SELECT RAISE(ABORT, 'is_active never goes back to 1');
END;

CREATE TRIGGER app_financial_account_type_fixed
BEFORE UPDATE OF type ON app_financial_account
WHEN NEW.type IS NOT OLD.type
BEGIN
  SELECT RAISE(ABORT, 'type never changes');
END;


-- ---------------------------------------------------------------- app_transaction_group
CREATE TABLE app_transaction_group (
  id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (length(id) = 36),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (created_at > 0),
  created_by TEXT NOT NULL,
  household_id TEXT NOT NULL REFERENCES tenant_household (id),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (updated_at > 0),
  updated_by TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE
    CHECK (name <> '' AND name COLLATE BINARY = trim(name))
    CHECK (length(name) <= 60),
  type TEXT NOT NULL CHECK (type IN ('expense', 'income')),
  icon TEXT NOT NULL DEFAULT '⭕️' CHECK (icon <> ''),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, created_by) REFERENCES tenant_household_member (household_id, user_id),
  FOREIGN KEY (household_id, updated_by) REFERENCES tenant_household_member (household_id, user_id)
) STRICT;
CREATE UNIQUE INDEX app_transaction_group_name_uq ON app_transaction_group (household_id, type, name) WHERE is_active = 1;

CREATE TRIGGER app_transaction_group_created_by_current
BEFORE INSERT ON app_transaction_group
WHEN (SELECT household_id FROM tenant_user WHERE id = NEW.created_by) IS NOT NEW.household_id
BEGIN
  SELECT RAISE(ABORT, 'created_by must currently be in this household');
END;

CREATE TRIGGER app_transaction_group_updated_by_current
BEFORE UPDATE ON app_transaction_group
WHEN (SELECT household_id FROM tenant_user WHERE id = NEW.updated_by) IS NOT NEW.household_id
BEGIN
  SELECT RAISE(ABORT, 'updated_by must currently be in this household');
END;

CREATE TRIGGER app_transaction_group_household_fixed
BEFORE UPDATE OF household_id ON app_transaction_group
WHEN NEW.household_id IS NOT OLD.household_id
BEGIN
  SELECT RAISE(ABORT, 'household_id never changes');
END;

CREATE TRIGGER app_transaction_group_no_restore
BEFORE UPDATE OF is_active ON app_transaction_group
WHEN OLD.is_active = 0 AND NEW.is_active = 1
BEGIN
  SELECT RAISE(ABORT, 'is_active never goes back to 1');
END;

CREATE TRIGGER app_transaction_group_type_fixed
BEFORE UPDATE OF type ON app_transaction_group
WHEN NEW.type IS NOT OLD.type
BEGIN
  SELECT RAISE(ABORT, 'type never changes');
END;

CREATE TRIGGER app_transaction_group_no_active_categories
BEFORE UPDATE OF is_active ON app_transaction_group
WHEN OLD.is_active = 1 AND NEW.is_active = 0 AND EXISTS (SELECT 1 FROM app_transaction_category WHERE household_id = OLD.household_id AND group_id = OLD.id AND is_active = 1)
BEGIN
  SELECT RAISE(ABORT, 'group still has active categories');
END;


-- ---------------------------------------------------------------- app_transaction_category
CREATE TABLE app_transaction_category (
  id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (length(id) = 36),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (created_at > 0),
  created_by TEXT NOT NULL,
  household_id TEXT NOT NULL REFERENCES tenant_household (id),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (updated_at > 0),
  updated_by TEXT NOT NULL,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE
    CHECK (name <> '' AND name COLLATE BINARY = trim(name))
    CHECK (length(name) <= 60),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, created_by) REFERENCES tenant_household_member (household_id, user_id),
  FOREIGN KEY (household_id, updated_by) REFERENCES tenant_household_member (household_id, user_id),
  FOREIGN KEY (household_id, group_id) REFERENCES app_transaction_group (household_id, id)
) STRICT;
CREATE UNIQUE INDEX app_transaction_category_name_uq ON app_transaction_category (household_id, name) WHERE is_active = 1;

CREATE TRIGGER app_transaction_category_created_by_current
BEFORE INSERT ON app_transaction_category
WHEN (SELECT household_id FROM tenant_user WHERE id = NEW.created_by) IS NOT NEW.household_id
BEGIN
  SELECT RAISE(ABORT, 'created_by must currently be in this household');
END;

CREATE TRIGGER app_transaction_category_updated_by_current
BEFORE UPDATE ON app_transaction_category
WHEN (SELECT household_id FROM tenant_user WHERE id = NEW.updated_by) IS NOT NEW.household_id
BEGIN
  SELECT RAISE(ABORT, 'updated_by must currently be in this household');
END;

CREATE TRIGGER app_transaction_category_household_fixed
BEFORE UPDATE OF household_id ON app_transaction_category
WHEN NEW.household_id IS NOT OLD.household_id
BEGIN
  SELECT RAISE(ABORT, 'household_id never changes');
END;

CREATE TRIGGER app_transaction_category_no_restore
BEFORE UPDATE OF is_active ON app_transaction_category
WHEN OLD.is_active = 0 AND NEW.is_active = 1
BEGIN
  SELECT RAISE(ABORT, 'is_active never goes back to 1');
END;

CREATE TRIGGER app_transaction_category_group_active_ins
BEFORE INSERT ON app_transaction_category
WHEN (SELECT is_active FROM app_transaction_group WHERE household_id = NEW.household_id AND id = NEW.group_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'group must be active');
END;

CREATE TRIGGER app_transaction_category_group_active_upd
BEFORE UPDATE OF group_id ON app_transaction_category
WHEN (SELECT is_active FROM app_transaction_group WHERE household_id = NEW.household_id AND id = NEW.group_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'group must be active');
END;

CREATE TRIGGER app_transaction_category_group_same_type
BEFORE UPDATE OF group_id ON app_transaction_category
WHEN (SELECT type FROM app_transaction_group WHERE household_id = OLD.household_id AND id = OLD.group_id) IS NOT (SELECT type FROM app_transaction_group WHERE household_id = NEW.household_id AND id = NEW.group_id)
BEGIN
  SELECT RAISE(ABORT, 'category can only move to a group of the same type');
END;


-- ---------------------------------------------------------------- app_transaction
CREATE TABLE app_transaction (
  id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (length(id) = 36),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (created_at > 0),
  created_by TEXT NOT NULL,
  household_id TEXT NOT NULL REFERENCES tenant_household (id),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (updated_at > 0),
  updated_by TEXT NOT NULL,
  "date" TEXT NOT NULL CHECK ("date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date("date") IS "date"),
  name TEXT NOT NULL
    CHECK (name <> '' AND name = trim(name))
    CHECK (length(name) <= 100),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  amount INTEGER NOT NULL CHECK (amount > 0),
  category_id TEXT,
  account_id TEXT NOT NULL,
  created_via_solms INTEGER NOT NULL DEFAULT 0 CHECK (created_via_solms IN (0, 1)),
  installment_term INTEGER NOT NULL DEFAULT 0
    CHECK (installment_term >= 0)
    CHECK (installment_term = 0 OR transaction_type = 'expense'),
  transaction_type TEXT NOT NULL
    CHECK (transaction_type IN ('initial', 'expense', 'income', 'transfer_in', 'transfer_out', 'adjust_up', 'adjust_down')),
  transfer_id TEXT NOT NULL DEFAULT '-'
    CHECK ((transaction_type IN ('transfer_in', 'transfer_out') AND transfer_id <> '-' AND transfer_id <> '')
        OR (transaction_type NOT IN ('transfer_in', 'transfer_out') AND transfer_id = '-')),
  ref_type TEXT NOT NULL DEFAULT 'no_ref' CHECK (ref_type IN ('no_ref', 'loan', 'recurring', 'cc_bill', 'receipt')),
  ref_id TEXT NOT NULL DEFAULT '-',
  flagged INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0, 1)),
  exclude_from_pnl INTEGER NOT NULL DEFAULT 0
    CHECK (exclude_from_pnl IN (0, 1))
    CHECK (transaction_type <> 'initial' OR exclude_from_pnl = 1),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, created_by) REFERENCES tenant_household_member (household_id, user_id),
  FOREIGN KEY (household_id, updated_by) REFERENCES tenant_household_member (household_id, user_id),
  FOREIGN KEY (household_id, category_id) REFERENCES app_transaction_category (household_id, id),
  FOREIGN KEY (household_id, account_id) REFERENCES app_financial_account (household_id, id),
  CHECK ((transaction_type IN ('expense', 'income') AND category_id IS NOT NULL)
      OR (transaction_type NOT IN ('expense', 'income') AND category_id IS NULL)),
  CHECK (ref_type <> 'cc_bill' OR transaction_type IN ('transfer_in', 'transfer_out')),
  CHECK (ref_type NOT IN ('loan', 'receipt') OR transaction_type = 'expense'),
  CHECK (ref_type <> 'recurring' OR transaction_type IN ('expense', 'income')),
  CHECK ((ref_type = 'no_ref' AND ref_id = '-') OR (ref_type <> 'no_ref' AND ref_id <> '-' AND ref_id <> ''))
) STRICT;
CREATE UNIQUE INDEX app_transaction_transfer_uq ON app_transaction (household_id, transfer_id, transaction_type) WHERE transfer_id <> '-';
CREATE INDEX app_transaction_date_idx ON app_transaction (household_id, "date") WHERE is_active = 1;
CREATE INDEX app_transaction_category_idx ON app_transaction (household_id, category_id) WHERE is_active = 1;
CREATE INDEX app_transaction_account_idx ON app_transaction (household_id, account_id) WHERE is_active = 1;
CREATE INDEX app_transaction_ref_idx ON app_transaction (household_id, ref_type, ref_id) WHERE ref_type <> 'no_ref';

CREATE TRIGGER app_transaction_created_by_current
BEFORE INSERT ON app_transaction
WHEN (SELECT household_id FROM tenant_user WHERE id = NEW.created_by) IS NOT NEW.household_id
BEGIN
  SELECT RAISE(ABORT, 'created_by must currently be in this household');
END;

CREATE TRIGGER app_transaction_updated_by_current
BEFORE UPDATE ON app_transaction
WHEN (SELECT household_id FROM tenant_user WHERE id = NEW.updated_by) IS NOT NEW.household_id
BEGIN
  SELECT RAISE(ABORT, 'updated_by must currently be in this household');
END;

CREATE TRIGGER app_transaction_household_fixed
BEFORE UPDATE OF household_id ON app_transaction
WHEN NEW.household_id IS NOT OLD.household_id
BEGIN
  SELECT RAISE(ABORT, 'household_id never changes');
END;

CREATE TRIGGER app_transaction_no_restore
BEFORE UPDATE OF is_active ON app_transaction
WHEN OLD.is_active = 0 AND NEW.is_active = 1
BEGIN
  SELECT RAISE(ABORT, 'is_active never goes back to 1');
END;

CREATE TRIGGER app_transaction_transaction_type_fixed
BEFORE UPDATE OF transaction_type ON app_transaction
WHEN NEW.transaction_type IS NOT OLD.transaction_type
BEGIN
  SELECT RAISE(ABORT, 'transaction_type never changes');
END;

CREATE TRIGGER app_transaction_category_type_ins
BEFORE INSERT ON app_transaction
WHEN NEW.category_id IS NOT NULL AND (SELECT g.type FROM app_transaction_category c JOIN app_transaction_group g ON g.household_id = c.household_id AND g.id = c.group_id WHERE c.household_id = NEW.household_id AND c.id = NEW.category_id) IS NOT NEW.transaction_type
BEGIN
  SELECT RAISE(ABORT, 'category group type must equal transaction_type');
END;

CREATE TRIGGER app_transaction_category_type_upd
BEFORE UPDATE OF category_id ON app_transaction
WHEN NEW.category_id IS NOT NULL AND (SELECT g.type FROM app_transaction_category c JOIN app_transaction_group g ON g.household_id = c.household_id AND g.id = c.group_id WHERE c.household_id = NEW.household_id AND c.id = NEW.category_id) IS NOT NEW.transaction_type
BEGIN
  SELECT RAISE(ABORT, 'category group type must equal transaction_type');
END;

CREATE TRIGGER app_transaction_account_active
BEFORE INSERT ON app_transaction
WHEN (SELECT is_active FROM app_financial_account WHERE household_id = NEW.household_id AND id = NEW.account_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'account must be active');
END;

CREATE TRIGGER app_transaction_ref_exists_insert
BEFORE INSERT ON app_transaction
WHEN (NEW.ref_type = 'loan' AND NOT EXISTS (SELECT 1 FROM app_loan WHERE household_id = NEW.household_id AND id = NEW.ref_id))
  OR (NEW.ref_type = 'recurring' AND NOT EXISTS (SELECT 1 FROM app_recurring_transaction WHERE household_id = NEW.household_id AND id = NEW.ref_id))
  OR (NEW.ref_type = 'cc_bill' AND NOT EXISTS (SELECT 1 FROM app_credit_card_bill WHERE household_id = NEW.household_id AND id = NEW.ref_id))
BEGIN
  SELECT RAISE(ABORT, 'referenced loan / recurring / cc_bill row must exist in this household');
END;

CREATE TRIGGER app_transaction_ref_exists_update
BEFORE UPDATE OF ref_type, ref_id ON app_transaction
WHEN (NEW.ref_type = 'loan' AND NOT EXISTS (SELECT 1 FROM app_loan WHERE household_id = NEW.household_id AND id = NEW.ref_id))
  OR (NEW.ref_type = 'recurring' AND NOT EXISTS (SELECT 1 FROM app_recurring_transaction WHERE household_id = NEW.household_id AND id = NEW.ref_id))
  OR (NEW.ref_type = 'cc_bill' AND NOT EXISTS (SELECT 1 FROM app_credit_card_bill WHERE household_id = NEW.household_id AND id = NEW.ref_id))
BEGIN
  SELECT RAISE(ABORT, 'referenced loan / recurring / cc_bill row must exist in this household');
END;

CREATE TRIGGER app_transaction_transfer_soft_delete
AFTER UPDATE OF is_active ON app_transaction
WHEN OLD.is_active = 1 AND NEW.is_active = 0 AND NEW.transfer_id <> '-'
BEGIN
  UPDATE app_transaction
     SET is_active = 0, updated_at = NEW.updated_at, updated_by = NEW.updated_by
   WHERE household_id = NEW.household_id AND transfer_id = NEW.transfer_id AND id <> NEW.id AND is_active = 1;
END;

-- ---------------------------------------------------------------- app_budget
CREATE TABLE app_budget (
  id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (length(id) = 36),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (created_at > 0),
  created_by TEXT NOT NULL,
  household_id TEXT NOT NULL REFERENCES tenant_household (id),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (updated_at > 0),
  updated_by TEXT NOT NULL,
  category_id TEXT,
  group_id TEXT,
  period_type TEXT NOT NULL DEFAULT 'monthly_cycle' CHECK (period_type IN ('monthly_cycle', 'date_range')),
  start_date TEXT NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(start_date) IS start_date),
  end_date TEXT
    CHECK (end_date IS NULL OR (end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(end_date) IS end_date))
    CHECK (end_date IS NULL OR end_date >= start_date),
  amount INTEGER NOT NULL CHECK (amount > 0),
  paid_offset INTEGER NOT NULL DEFAULT 0
    CHECK (paid_offset >= 0)
    CHECK (period_type <> 'monthly_cycle' OR paid_offset = 0),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, created_by) REFERENCES tenant_household_member (household_id, user_id),
  FOREIGN KEY (household_id, updated_by) REFERENCES tenant_household_member (household_id, user_id),
  FOREIGN KEY (household_id, category_id) REFERENCES app_transaction_category (household_id, id),
  FOREIGN KEY (household_id, group_id) REFERENCES app_transaction_group (household_id, id),
  CHECK ((category_id IS NULL) <> (group_id IS NULL)),
  CHECK ((period_type = 'date_range' AND end_date IS NOT NULL) OR (period_type = 'monthly_cycle' AND end_date IS NULL))
) STRICT;
CREATE UNIQUE INDEX app_budget_category_uq ON app_budget (household_id, category_id) WHERE period_type = 'monthly_cycle' AND is_active = 1 AND category_id IS NOT NULL;
CREATE UNIQUE INDEX app_budget_group_uq ON app_budget (household_id, group_id) WHERE period_type = 'monthly_cycle' AND is_active = 1 AND group_id IS NOT NULL;

CREATE TRIGGER app_budget_created_by_current
BEFORE INSERT ON app_budget
WHEN (SELECT household_id FROM tenant_user WHERE id = NEW.created_by) IS NOT NEW.household_id
BEGIN
  SELECT RAISE(ABORT, 'created_by must currently be in this household');
END;

CREATE TRIGGER app_budget_updated_by_current
BEFORE UPDATE ON app_budget
WHEN (SELECT household_id FROM tenant_user WHERE id = NEW.updated_by) IS NOT NEW.household_id
BEGIN
  SELECT RAISE(ABORT, 'updated_by must currently be in this household');
END;

CREATE TRIGGER app_budget_household_fixed
BEFORE UPDATE OF household_id ON app_budget
WHEN NEW.household_id IS NOT OLD.household_id
BEGIN
  SELECT RAISE(ABORT, 'household_id never changes');
END;

CREATE TRIGGER app_budget_no_restore
BEFORE UPDATE OF is_active ON app_budget
WHEN OLD.is_active = 0 AND NEW.is_active = 1
BEGIN
  SELECT RAISE(ABORT, 'is_active never goes back to 1');
END;

CREATE TRIGGER app_budget_category_expense_insert
BEFORE INSERT ON app_budget
WHEN NEW.category_id IS NOT NULL AND (SELECT g.type FROM app_transaction_category c JOIN app_transaction_group g ON g.household_id = c.household_id AND g.id = c.group_id WHERE c.household_id = NEW.household_id AND c.id = NEW.category_id) IS NOT 'expense'
BEGIN
  SELECT RAISE(ABORT, 'category must belong to an expense group');
END;

CREATE TRIGGER app_budget_group_expense_insert
BEFORE INSERT ON app_budget
WHEN NEW.group_id IS NOT NULL AND (SELECT type FROM app_transaction_group WHERE household_id = NEW.household_id AND id = NEW.group_id) IS NOT 'expense'
BEGIN
  SELECT RAISE(ABORT, 'group must belong to an expense group');
END;

CREATE TRIGGER app_budget_category_expense_update
BEFORE UPDATE OF category_id ON app_budget
WHEN NEW.category_id IS NOT NULL AND (SELECT g.type FROM app_transaction_category c JOIN app_transaction_group g ON g.household_id = c.household_id AND g.id = c.group_id WHERE c.household_id = NEW.household_id AND c.id = NEW.category_id) IS NOT 'expense'
BEGIN
  SELECT RAISE(ABORT, 'category must belong to an expense group');
END;

CREATE TRIGGER app_budget_group_expense_update
BEFORE UPDATE OF group_id ON app_budget
WHEN NEW.group_id IS NOT NULL AND (SELECT type FROM app_transaction_group WHERE household_id = NEW.household_id AND id = NEW.group_id) IS NOT 'expense'
BEGIN
  SELECT RAISE(ABORT, 'group must belong to an expense group');
END;


-- ---------------------------------------------------------------- app_credit_card_bill
CREATE TABLE app_credit_card_bill (
  id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (length(id) = 36),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (created_at > 0),
  created_by TEXT NOT NULL,
  household_id TEXT NOT NULL REFERENCES tenant_household (id),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (updated_at > 0),
  updated_by TEXT NOT NULL,
  "date" TEXT NOT NULL CHECK ("date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date("date") IS "date"),
  account_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  minimum_payment INTEGER NOT NULL DEFAULT 0 CHECK (minimum_payment >= 0 AND minimum_payment <= amount),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, created_by) REFERENCES tenant_household_member (household_id, user_id),
  FOREIGN KEY (household_id, updated_by) REFERENCES tenant_household_member (household_id, user_id),
  FOREIGN KEY (household_id, account_id) REFERENCES app_financial_account (household_id, id)
) STRICT;
CREATE UNIQUE INDEX app_credit_card_bill_date_uq ON app_credit_card_bill (household_id, account_id, "date") WHERE is_active = 1;

CREATE TRIGGER app_credit_card_bill_created_by_current
BEFORE INSERT ON app_credit_card_bill
WHEN (SELECT household_id FROM tenant_user WHERE id = NEW.created_by) IS NOT NEW.household_id
BEGIN
  SELECT RAISE(ABORT, 'created_by must currently be in this household');
END;

CREATE TRIGGER app_credit_card_bill_updated_by_current
BEFORE UPDATE ON app_credit_card_bill
WHEN (SELECT household_id FROM tenant_user WHERE id = NEW.updated_by) IS NOT NEW.household_id
BEGIN
  SELECT RAISE(ABORT, 'updated_by must currently be in this household');
END;

CREATE TRIGGER app_credit_card_bill_household_fixed
BEFORE UPDATE OF household_id ON app_credit_card_bill
WHEN NEW.household_id IS NOT OLD.household_id
BEGIN
  SELECT RAISE(ABORT, 'household_id never changes');
END;

CREATE TRIGGER app_credit_card_bill_no_restore
BEFORE UPDATE OF is_active ON app_credit_card_bill
WHEN OLD.is_active = 0 AND NEW.is_active = 1
BEGIN
  SELECT RAISE(ABORT, 'is_active never goes back to 1');
END;

CREATE TRIGGER app_credit_card_bill_account_id_fixed
BEFORE UPDATE OF account_id ON app_credit_card_bill
WHEN NEW.account_id IS NOT OLD.account_id
BEGIN
  SELECT RAISE(ABORT, 'account_id never changes');
END;

CREATE TRIGGER app_credit_card_bill_account_is_card
BEFORE INSERT ON app_credit_card_bill
WHEN (SELECT type FROM app_financial_account WHERE household_id = NEW.household_id AND id = NEW.account_id) IS NOT 'credit_card'
BEGIN
  SELECT RAISE(ABORT, 'account must be a credit_card');
END;


-- ---------------------------------------------------------------- app_recurring_transaction
CREATE TABLE app_recurring_transaction (
  id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (length(id) = 36),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (created_at > 0),
  created_by TEXT NOT NULL,
  household_id TEXT NOT NULL REFERENCES tenant_household (id),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (updated_at > 0),
  updated_by TEXT NOT NULL,
  recurring_day INTEGER NOT NULL CHECK (recurring_day BETWEEN 1 AND 31),
  name TEXT NOT NULL COLLATE NOCASE
    CHECK (name <> '' AND name COLLATE BINARY = trim(name))
    CHECK (length(name) <= 100),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  amount INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
  category_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  auto_debit INTEGER NOT NULL DEFAULT 0 CHECK (auto_debit IN (0, 1)),
  start_date TEXT NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(start_date) IS start_date),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, created_by) REFERENCES tenant_household_member (household_id, user_id),
  FOREIGN KEY (household_id, updated_by) REFERENCES tenant_household_member (household_id, user_id),
  FOREIGN KEY (household_id, category_id) REFERENCES app_transaction_category (household_id, id),
  FOREIGN KEY (household_id, account_id) REFERENCES app_financial_account (household_id, id)
) STRICT;
CREATE UNIQUE INDEX app_recurring_transaction_name_uq ON app_recurring_transaction (household_id, name) WHERE is_active = 1;

CREATE TRIGGER app_recurring_transaction_created_by_current
BEFORE INSERT ON app_recurring_transaction
WHEN (SELECT household_id FROM tenant_user WHERE id = NEW.created_by) IS NOT NEW.household_id
BEGIN
  SELECT RAISE(ABORT, 'created_by must currently be in this household');
END;

CREATE TRIGGER app_recurring_transaction_updated_by_current
BEFORE UPDATE ON app_recurring_transaction
WHEN (SELECT household_id FROM tenant_user WHERE id = NEW.updated_by) IS NOT NEW.household_id
BEGIN
  SELECT RAISE(ABORT, 'updated_by must currently be in this household');
END;

CREATE TRIGGER app_recurring_transaction_household_fixed
BEFORE UPDATE OF household_id ON app_recurring_transaction
WHEN NEW.household_id IS NOT OLD.household_id
BEGIN
  SELECT RAISE(ABORT, 'household_id never changes');
END;

CREATE TRIGGER app_recurring_transaction_no_restore
BEFORE UPDATE OF is_active ON app_recurring_transaction
WHEN OLD.is_active = 0 AND NEW.is_active = 1
BEGIN
  SELECT RAISE(ABORT, 'is_active never goes back to 1');
END;


-- ---------------------------------------------------------------- app_loan
CREATE TABLE app_loan (
  id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (length(id) = 36),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (created_at > 0),
  created_by TEXT NOT NULL,
  household_id TEXT NOT NULL REFERENCES tenant_household (id),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (updated_at > 0),
  updated_by TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE
    CHECK (name <> '' AND name COLLATE BINARY = trim(name))
    CHECK (length(name) <= 100),
  account_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  interest_rate REAL NOT NULL DEFAULT 0 CHECK (interest_rate >= 0),
  monthly_payment_amount INTEGER NOT NULL CHECK (monthly_payment_amount > 0),
  total_terms INTEGER NOT NULL CHECK (total_terms > 0),
  terms_paid_offset INTEGER NOT NULL DEFAULT 0 CHECK (terms_paid_offset >= 0 AND terms_paid_offset <= total_terms),
  start_date TEXT NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(start_date) IS start_date),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, created_by) REFERENCES tenant_household_member (household_id, user_id),
  FOREIGN KEY (household_id, updated_by) REFERENCES tenant_household_member (household_id, user_id),
  FOREIGN KEY (household_id, account_id) REFERENCES app_financial_account (household_id, id),
  FOREIGN KEY (household_id, category_id) REFERENCES app_transaction_category (household_id, id)
) STRICT;
CREATE UNIQUE INDEX app_loan_name_uq ON app_loan (household_id, name) WHERE is_active = 1;

CREATE TRIGGER app_loan_created_by_current
BEFORE INSERT ON app_loan
WHEN (SELECT household_id FROM tenant_user WHERE id = NEW.created_by) IS NOT NEW.household_id
BEGIN
  SELECT RAISE(ABORT, 'created_by must currently be in this household');
END;

CREATE TRIGGER app_loan_updated_by_current
BEFORE UPDATE ON app_loan
WHEN (SELECT household_id FROM tenant_user WHERE id = NEW.updated_by) IS NOT NEW.household_id
BEGIN
  SELECT RAISE(ABORT, 'updated_by must currently be in this household');
END;

CREATE TRIGGER app_loan_household_fixed
BEFORE UPDATE OF household_id ON app_loan
WHEN NEW.household_id IS NOT OLD.household_id
BEGIN
  SELECT RAISE(ABORT, 'household_id never changes');
END;

CREATE TRIGGER app_loan_no_restore
BEFORE UPDATE OF is_active ON app_loan
WHEN OLD.is_active = 0 AND NEW.is_active = 1
BEGIN
  SELECT RAISE(ABORT, 'is_active never goes back to 1');
END;

CREATE TRIGGER app_loan_category_expense_ins
BEFORE INSERT ON app_loan
WHEN (SELECT g.type FROM app_transaction_category c JOIN app_transaction_group g ON g.household_id = c.household_id AND g.id = c.group_id WHERE c.household_id = NEW.household_id AND c.id = NEW.category_id) IS NOT 'expense'
BEGIN
  SELECT RAISE(ABORT, 'category must belong to an expense group');
END;

CREATE TRIGGER app_loan_category_expense_upd
BEFORE UPDATE OF category_id ON app_loan
WHEN (SELECT g.type FROM app_transaction_category c JOIN app_transaction_group g ON g.household_id = c.household_id AND g.id = c.group_id WHERE c.household_id = NEW.household_id AND c.id = NEW.category_id) IS NOT 'expense'
BEGIN
  SELECT RAISE(ABORT, 'category must belong to an expense group');
END;


-- ---------------------------------------------------------------- app_household_setting
CREATE TABLE app_household_setting (
  household_id TEXT NOT NULL PRIMARY KEY REFERENCES tenant_household (id),
  cycle_start_day INTEGER NOT NULL DEFAULT 1 CHECK (cycle_start_day BETWEEN 1 AND 31),
  savings_target_amount INTEGER NOT NULL DEFAULT 0 CHECK (savings_target_amount >= 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (updated_at > 0),
  updated_by TEXT NOT NULL,
  savings_target_metrics TEXT NOT NULL DEFAULT 'net_balance' CHECK (savings_target_metrics IN ('net_balance', 'net_worth')),
  timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta' CHECK (timezone <> ''),
  FOREIGN KEY (household_id, updated_by) REFERENCES tenant_household_member (household_id, user_id)
) STRICT;

CREATE TRIGGER app_household_setting_updated_by_current
BEFORE UPDATE ON app_household_setting
WHEN (SELECT household_id FROM tenant_user WHERE id = NEW.updated_by) IS NOT NEW.household_id
BEGIN
  SELECT RAISE(ABORT, 'updated_by must currently be in this household');
END;

