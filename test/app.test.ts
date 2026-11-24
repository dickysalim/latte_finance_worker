import { describe, expect, it } from "vitest";
import {
  insertTransaction, joinHousehold, nextN, rejects, row, rows, run, seedAccount, seedCard, seedCategory, seedGroup, seedHousehold, seedUser, uid,
} from "./helpers";

describe("shared columns (checked on app_financial_account)", () => {
  const ins = (c: { hh: string; owner: string }, over: Record<string, unknown> = {}) => {
    const v = { id: uid(), created_by: c.owner, household_id: c.hh, updated_by: c.owner, name: `acc ${nextN()}`, ...over };
    return run("INSERT INTO app_financial_account (id, created_by, household_id, updated_by, name, type) VALUES (?, ?, ?, ?, ?, 'bank_account')", v.id, v.created_by, v.household_id, v.updated_by, v.name);
  };
  it("valid insert passes; id is a UUID by default", async () => {
    const c = await seedHousehold();
    await ins(c);
    await run("INSERT INTO app_financial_account (created_by, household_id, updated_by, name, type) VALUES (?, ?, ?, 'auto id', 'bank_account')", c.owner, c.hh, c.owner);
    expect((await row("SELECT id FROM app_financial_account WHERE name = 'auto id'")).id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("FK: created_by must be a member of the household", async () => {
    const a = await seedHousehold();
    const b = await seedHousehold();
    await rejects(ins(a, { created_by: b.owner }), /FOREIGN KEY|created_by must/);
  });
  it("trigger: created_by's current household must be this household", async () => {
    const a = await seedHousehold();
    const b = await seedHousehold();
    await run("INSERT INTO tenant_household_member (household_id, user_id) VALUES (?, ?)", b.hh, a.owner);
    await run("UPDATE tenant_user SET household_id = ? WHERE id = ?", b.hh, a.owner);
    await rejects(ins(a), /created_by must currently/);
  });
  it("trigger: updated_by's current household must be this household", async () => {
    const a = await seedHousehold();
    const id = await seedAccount(a);
    const u = await seedUser();
    await joinHousehold(u.id, a.hh);
    await run("UPDATE app_financial_account SET updated_by = ? WHERE id = ?", u.id, id);
    await run("UPDATE tenant_user SET household_id = ? WHERE id = ?", a.hh, u.id);
    const b = await seedHousehold();
    await run("INSERT INTO tenant_household_member (household_id, user_id) VALUES (?, ?)", b.hh, u.id);
    await run("UPDATE tenant_user SET household_id = ? WHERE id = ?", b.hh, u.id);
    await rejects(run("UPDATE app_financial_account SET name = 'renamed' WHERE id = ?", id), /updated_by must currently/);
  });
  it("household_id never changes", async () => {
    const a = await seedHousehold();
    const b = await seedHousehold();
    const id = await seedAccount(a);
    await rejects(run("UPDATE app_financial_account SET household_id = ? WHERE id = ?", b.hh, id), /never changes/);
  });
  it("is_active: 0 / 1 only, 1 to 0 only", async () => {
    const a = await seedHousehold();
    const id = await seedAccount(a);
    await rejects(run("UPDATE app_financial_account SET is_active = 2 WHERE id = ?", id), /CHECK/);
    await run("UPDATE app_financial_account SET is_active = 0 WHERE id = ?", id);
    await rejects(run("UPDATE app_financial_account SET is_active = 1 WHERE id = ?", id), /never goes back/);
  });
  it("created_at / updated_at > 0; id length 36", async () => {
    const a = await seedHousehold();
    await rejects(run("INSERT INTO app_financial_account (created_by, household_id, updated_by, name, type, created_at) VALUES (?, ?, ?, 'x1', 'bank_account', 0)", a.owner, a.hh, a.owner), /CHECK/);
    await rejects(run("INSERT INTO app_financial_account (id, created_by, household_id, updated_by, name, type) VALUES ('short', ?, ?, ?, 'x2', 'bank_account')", a.owner, a.hh, a.owner), /CHECK/);
  });
});

describe("app_financial_account", () => {
  const ins = (c: { hh: string; owner: string }, over: Record<string, unknown> = {}) => {
    const v = { name: `acc ${nextN()}`, type: "bank_account", target_saving: null, credit_limit: null, bill_day: null, ...over };
    return run("INSERT INTO app_financial_account (created_by, household_id, updated_by, name, type, target_saving, credit_limit, bill_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", c.owner, c.hh, c.owner, v.name, v.type, v.target_saving, v.credit_limit, v.bill_day);
  };
  it("each type with its own columns passes", async () => {
    const c = await seedHousehold();
    await ins(c);
    await ins(c, { type: "saving_account", target_saving: 0 });
    await ins(c, { type: "credit_card", credit_limit: 1000, bill_day: 0 });
  });
  it("type must be a known value and never changes", async () => {
    const c = await seedHousehold();
    await rejects(ins(c, { type: "cash" }), /CHECK/);
    const id = await seedAccount(c);
    await rejects(run("UPDATE app_financial_account SET type = 'saving_account', target_saving = 1 WHERE id = ?", id), /never changes/);
  });
  it("saving_account needs target_saving >= 0; others must have NULL", async () => {
    const c = await seedHousehold();
    await rejects(ins(c, { type: "saving_account" }), /CHECK/);
    await rejects(ins(c, { type: "saving_account", target_saving: -1 }), /CHECK/);
    await rejects(ins(c, { type: "bank_account", target_saving: 5 }), /CHECK/);
  });
  it("credit_card needs credit_limit > 0 and bill_day 0..31; others must have NULL", async () => {
    const c = await seedHousehold();
    await rejects(ins(c, { type: "credit_card", bill_day: 5 }), /CHECK/);
    await rejects(ins(c, { type: "credit_card", credit_limit: 0, bill_day: 5 }), /CHECK/);
    await rejects(ins(c, { type: "credit_card", credit_limit: 10 }), /CHECK/);
    await rejects(ins(c, { type: "credit_card", credit_limit: 10, bill_day: 32 }), /CHECK/);
    await rejects(ins(c, { credit_limit: 10 }), /CHECK/);
    await rejects(ins(c, { bill_day: 5 }), /CHECK/);
  });
  it("name: not empty, trimmed, <= 60, unique among active (case-insensitive)", async () => {
    const c = await seedHousehold();
    await rejects(ins(c, { name: "" }), /CHECK/);
    await rejects(ins(c, { name: " pad " }), /CHECK/);
    await rejects(ins(c, { name: "a".repeat(61) }), /CHECK/);
    await ins(c, { name: "Main" });
    await rejects(ins(c, { name: "main" }), /UNIQUE/);
    await run("UPDATE app_financial_account SET is_active = 0 WHERE name = 'Main' AND household_id = ?", c.hh);
    await ins(c, { name: "main" });
  });
  it("same name in another household is fine", async () => {
    const a = await seedHousehold();
    const b = await seedHousehold();
    await ins(a, { name: "shared name" });
    await ins(b, { name: "shared name" });
  });
});

describe("app_transaction_group", () => {
  const ins = (c: { hh: string; owner: string }, over: Record<string, unknown> = {}) => {
    const v = { name: `g ${nextN()}`, type: "expense", icon: "🍜", ...over };
    return run("INSERT INTO app_transaction_group (created_by, household_id, updated_by, name, type, icon) VALUES (?, ?, ?, ?, ?, ?)", c.owner, c.hh, c.owner, v.name, v.type, v.icon);
  };
  it("valid insert passes; default icon is applied", async () => {
    const c = await seedHousehold();
    await ins(c);
    await run("INSERT INTO app_transaction_group (created_by, household_id, updated_by, name, type) VALUES (?, ?, ?, 'noicon', 'income')", c.owner, c.hh, c.owner);
    expect((await row("SELECT icon FROM app_transaction_group WHERE name = 'noicon'")).icon).toBe("⭕️");
  });
  it("type expense / income only; never changes", async () => {
    const c = await seedHousehold();
    await rejects(ins(c, { type: "transfer" }), /CHECK/);
    const id = await seedGroup(c);
    await rejects(run("UPDATE app_transaction_group SET type = 'income' WHERE id = ?", id), /never changes/);
  });
  it("name rules; unique per (household, type, name) while active", async () => {
    const c = await seedHousehold();
    await rejects(ins(c, { name: "" }), /CHECK/);
    await rejects(ins(c, { name: "a".repeat(61) }), /CHECK/);
    await ins(c, { name: "Food", type: "expense" });
    await rejects(ins(c, { name: "food", type: "expense" }), /UNIQUE/);
    await ins(c, { name: "food", type: "income" });
  });
  it("icon not empty", async () => {
    const c = await seedHousehold();
    await rejects(ins(c, { icon: "" }), /CHECK/);
  });
  it("trigger: cannot deactivate a group that still has active categories", async () => {
    const c = await seedHousehold();
    const cat = await seedCategory(c);
    await rejects(run("UPDATE app_transaction_group SET is_active = 0 WHERE id = ?", cat.groupId), /active categories/);
    await run("UPDATE app_transaction_category SET is_active = 0 WHERE id = ?", cat.id);
    await run("UPDATE app_transaction_group SET is_active = 0 WHERE id = ?", cat.groupId);
  });
});

describe("app_transaction_category", () => {
  it("valid insert passes; group must exist in the same household (FK)", async () => {
    const a = await seedHousehold();
    const b = await seedHousehold();
    await seedCategory(a);
    const gb = await seedGroup(b);
    await rejects(run("INSERT INTO app_transaction_category (created_by, household_id, updated_by, group_id, name) VALUES (?, ?, ?, ?, 'x')", a.owner, a.hh, a.owner, gb), /FOREIGN KEY|group must be active/);
  });
  it("trigger: group must be active (insert and move)", async () => {
    const c = await seedHousehold();
    const g = await seedGroup(c);
    await run("UPDATE app_transaction_group SET is_active = 0 WHERE id = ?", g);
    await rejects(run("INSERT INTO app_transaction_category (created_by, household_id, updated_by, group_id, name) VALUES (?, ?, ?, ?, 'y')", c.owner, c.hh, c.owner, g), /group must be active/);
    const cat = await seedCategory(c);
    await rejects(run("UPDATE app_transaction_category SET group_id = ? WHERE id = ?", g, cat.id), /group must be active/);
  });
  it("trigger: may move only to a group of the same type", async () => {
    const c = await seedHousehold();
    const cat = await seedCategory(c, "expense");
    const other = await seedGroup(c, "expense");
    const inc = await seedGroup(c, "income");
    await rejects(run("UPDATE app_transaction_category SET group_id = ? WHERE id = ?", inc, cat.id), /same type/);
    await run("UPDATE app_transaction_category SET group_id = ? WHERE id = ?", other, cat.id);
  });
  it("name rules; unique per household while active", async () => {
    const c = await seedHousehold();
    const g = await seedGroup(c);
    const ins = (name: string) => run("INSERT INTO app_transaction_category (created_by, household_id, updated_by, group_id, name) VALUES (?, ?, ?, ?, ?)", c.owner, c.hh, c.owner, g, name);
    await rejects(ins(""), /CHECK/);
    await rejects(ins(" x "), /CHECK/);
    await rejects(ins("a".repeat(61)), /CHECK/);
    await ins("Coffee");
    await rejects(ins("coffee"), /UNIQUE/);
  });
});

describe("app_transaction", () => {
  it("valid rows of every type pass", async () => {
    const c = await seedHousehold();
    const acc = await seedAccount(c);
    const exp = await seedCategory(c, "expense");
    const inc = await seedCategory(c, "income");
    await insertTransaction(c, { account_id: acc, transaction_type: "initial", exclude_from_pnl: 1 });
    await insertTransaction(c, { account_id: acc, transaction_type: "expense", category_id: exp.id });
    await insertTransaction(c, { account_id: acc, transaction_type: "income", category_id: inc.id });
    await insertTransaction(c, { account_id: acc, transaction_type: "adjust_up" });
    await insertTransaction(c, { account_id: acc, transaction_type: "adjust_down" });
    const t = uid();
    await insertTransaction(c, { account_id: acc, transaction_type: "transfer_out", transfer_id: t });
    await insertTransaction(c, { account_id: acc, transaction_type: "transfer_in", transfer_id: t });
    expect((await row("SELECT count(*) AS n FROM app_transaction WHERE household_id = ?", c.hh)).n).toBe(7);
  });
  it("date: YYYY-MM-DD and a real date", async () => {
    const c = await seedHousehold();
    const acc = await seedAccount(c);
    for (const bad of ["2026-13-01", "2026-02-30", "20-11-2026", "2026-1-1", "", "2026-11-20 10:00"]) {
      await rejects(insertTransaction(c, { account_id: acc, date: bad }), /CHECK/);
    }
  });
  it("name not empty, trimmed, <= 100; description <= 500, defaults to empty string", async () => {
    const c = await seedHousehold();
    const acc = await seedAccount(c);
    await rejects(insertTransaction(c, { account_id: acc, name: "" }), /CHECK/);
    await rejects(insertTransaction(c, { account_id: acc, name: " x" }), /CHECK/);
    await rejects(insertTransaction(c, { account_id: acc, name: "a".repeat(101) }), /CHECK/);
    await rejects(insertTransaction(c, { account_id: acc, description: "a".repeat(501) }), /CHECK/);
    const id = await insertTransaction(c, { account_id: acc });
    expect((await row("SELECT description FROM app_transaction WHERE id = ?", id)).description).toBe("");
  });
  it("amount > 0", async () => {
    const c = await seedHousehold();
    const acc = await seedAccount(c);
    await rejects(insertTransaction(c, { account_id: acc, amount: 0 }), /CHECK/);
    await rejects(insertTransaction(c, { account_id: acc, amount: -5 }), /CHECK/);
  });
  it("transaction_type must be a known value and never changes", async () => {
    const c = await seedHousehold();
    const acc = await seedAccount(c);
    await rejects(insertTransaction(c, { account_id: acc, transaction_type: "refund" }), /CHECK/);
    const id = await insertTransaction(c, { account_id: acc });
    await rejects(run("UPDATE app_transaction SET transaction_type = 'adjust_down' WHERE id = ?", id), /never changes/);
  });
  it("category_id required for expense / income, NULL for the others", async () => {
    const c = await seedHousehold();
    const acc = await seedAccount(c);
    const exp = await seedCategory(c, "expense");
    await rejects(insertTransaction(c, { account_id: acc, transaction_type: "expense" }), /CHECK/);
    await rejects(insertTransaction(c, { account_id: acc, transaction_type: "adjust_up", category_id: exp.id }), /CHECK|group type/);
  });
  it("trigger: category group type must equal transaction_type (insert and update)", async () => {
    const c = await seedHousehold();
    const acc = await seedAccount(c);
    const exp = await seedCategory(c, "expense");
    const inc = await seedCategory(c, "income");
    await rejects(insertTransaction(c, { account_id: acc, transaction_type: "income", category_id: exp.id }), /group type/);
    const id = await insertTransaction(c, { account_id: acc, transaction_type: "expense", category_id: exp.id });
    await rejects(run("UPDATE app_transaction SET category_id = ? WHERE id = ?", inc.id, id), /group type/);
  });
  it("FK: account and category must belong to the same household", async () => {
    const a = await seedHousehold();
    const b = await seedHousehold();
    const accB = await seedAccount(b);
    await rejects(insertTransaction(a, { account_id: accB }), /FOREIGN KEY|account must be active/);
    const accA = await seedAccount(a);
    const catB = await seedCategory(b, "expense");
    await rejects(insertTransaction(a, { account_id: accA, transaction_type: "expense", category_id: catB.id }), /FOREIGN KEY|group type/);
  });
  it("trigger: account must be active on insert", async () => {
    const c = await seedHousehold();
    const acc = await seedAccount(c);
    await run("UPDATE app_financial_account SET is_active = 0 WHERE id = ?", acc);
    await rejects(insertTransaction(c, { account_id: acc }), /account must be active/);
  });
  it("installment_term >= 0 and only on expense", async () => {
    const c = await seedHousehold();
    const acc = await seedAccount(c);
    const exp = await seedCategory(c, "expense");
    await rejects(insertTransaction(c, { account_id: acc, installment_term: -1 }), /CHECK/);
    await rejects(insertTransaction(c, { account_id: acc, installment_term: 3 }), /CHECK/);
    await insertTransaction(c, { account_id: acc, transaction_type: "expense", category_id: exp.id, installment_term: 12 });
  });
  it("flagged, created_via_solms, exclude_from_pnl are 0 / 1; initial must be excluded from P&L", async () => {
    const c = await seedHousehold();
    const acc = await seedAccount(c);
    await rejects(insertTransaction(c, { account_id: acc, flagged: 2 }), /CHECK/);
    await rejects(insertTransaction(c, { account_id: acc, created_via_solms: 2 }), /CHECK/);
    await rejects(insertTransaction(c, { account_id: acc, exclude_from_pnl: 2 }), /CHECK/);
    await rejects(insertTransaction(c, { account_id: acc, transaction_type: "initial" }), /CHECK/);
  });

  describe("transfers", () => {
    it("transfer types need a real transfer_id; others must keep '-'", async () => {
      const c = await seedHousehold();
      const acc = await seedAccount(c);
      await rejects(insertTransaction(c, { account_id: acc, transaction_type: "transfer_out" }), /CHECK/);
      await rejects(insertTransaction(c, { account_id: acc, transaction_type: "transfer_in", transfer_id: "" }), /CHECK/);
      await rejects(insertTransaction(c, { account_id: acc, transfer_id: "t1" }), /CHECK/);
    });
    it("a transfer id is used once per type (a pair is exactly one out + one in)", async () => {
      const c = await seedHousehold();
      const acc = await seedAccount(c);
      const t = uid();
      await insertTransaction(c, { account_id: acc, transaction_type: "transfer_out", transfer_id: t });
      await rejects(insertTransaction(c, { account_id: acc, transaction_type: "transfer_out", transfer_id: t }), /UNIQUE/);
      await insertTransaction(c, { account_id: acc, transaction_type: "transfer_in", transfer_id: t });
    });
    it("trigger: soft delete of one leg soft deletes the other leg", async () => {
      const c = await seedHousehold();
      const acc = await seedAccount(c);
      const t = uid();
      const out = await insertTransaction(c, { account_id: acc, transaction_type: "transfer_out", transfer_id: t });
      const inn = await insertTransaction(c, { account_id: acc, transaction_type: "transfer_in", transfer_id: t });
      await run("UPDATE app_transaction SET is_active = 0 WHERE id = ?", out);
      expect((await row("SELECT is_active FROM app_transaction WHERE id = ?", inn)).is_active).toBe(0);
    });
    it("soft delete of a plain transaction leaves others alone", async () => {
      const c = await seedHousehold();
      const acc = await seedAccount(c);
      const x = await insertTransaction(c, { account_id: acc });
      const y = await insertTransaction(c, { account_id: acc });
      await run("UPDATE app_transaction SET is_active = 0 WHERE id = ?", x);
      expect((await row("SELECT is_active FROM app_transaction WHERE id = ?", y)).is_active).toBe(1);
    });
  });

  describe("refs", () => {
    it("ref_type must be known; ref_id '-' exactly when no_ref", async () => {
      const c = await seedHousehold();
      const acc = await seedAccount(c);
      const exp = await seedCategory(c, "expense");
      const e = { account_id: acc, transaction_type: "expense", category_id: exp.id };
      await rejects(insertTransaction(c, { ...e, ref_type: "invoice", ref_id: "x" }), /CHECK/);
      await rejects(insertTransaction(c, { ...e, ref_type: "receipt" }), /CHECK/);
      await rejects(insertTransaction(c, { ...e, ref_id: "r1" }), /CHECK/);
      await insertTransaction(c, { ...e, ref_type: "receipt", ref_id: "batch-1" });
    });
    it("cc_bill only on transfers; loan and receipt only on expense; recurring only on expense or income", async () => {
      const c = await seedHousehold();
      const acc = await seedAccount(c);
      const exp = await seedCategory(c, "expense");
      const inc = await seedCategory(c, "income");
      // real referenced rows, so only the CHECK can refuse
      const card = await seedCard(c);
      const bill = uid();
      await run('INSERT INTO app_credit_card_bill (id, created_by, household_id, updated_by, account_id, "date", amount) VALUES (?, ?, ?, ?, ?, \'2026-11-15\', 100)', bill, c.owner, c.hh, c.owner, card);
      const loan = uid();
      await run("INSERT INTO app_loan (id, created_by, household_id, updated_by, name, account_id, category_id, monthly_payment_amount, total_terms, start_date) VALUES (?, ?, ?, ?, 'l', ?, ?, 1000, 12, '2026-01-05')", loan, c.owner, c.hh, c.owner, acc, exp.id);
      const rec = uid();
      await run("INSERT INTO app_recurring_transaction (id, created_by, household_id, updated_by, recurring_day, name, category_id, account_id, start_date) VALUES (?, ?, ?, ?, 5, 'r', ?, ?, '2026-11-05')", rec, c.owner, c.hh, c.owner, exp.id, acc);
      await rejects(insertTransaction(c, { account_id: acc, transaction_type: "expense", category_id: exp.id, ref_type: "cc_bill", ref_id: bill }), /CHECK/);
      await insertTransaction(c, { account_id: acc, transaction_type: "transfer_out", transfer_id: uid(), ref_type: "cc_bill", ref_id: bill });
      await rejects(insertTransaction(c, { account_id: acc, transaction_type: "income", category_id: inc.id, ref_type: "loan", ref_id: loan }), /CHECK/);
      await rejects(insertTransaction(c, { account_id: acc, transaction_type: "income", category_id: inc.id, ref_type: "receipt", ref_id: "x" }), /CHECK/);
      await rejects(insertTransaction(c, { account_id: acc, transaction_type: "adjust_up", ref_type: "recurring", ref_id: rec }), /CHECK/);
      await insertTransaction(c, { account_id: acc, transaction_type: "income", category_id: inc.id, ref_type: "recurring", ref_id: rec });
    });
    it("trigger: loan / recurring / cc_bill ref must exist in the same household", async () => {
      const c = await seedHousehold();
      const acc = await seedAccount(c);
      const exp = await seedCategory(c, "expense");
      const e = { account_id: acc, transaction_type: "expense", category_id: exp.id };
      await rejects(insertTransaction(c, { ...e, ref_type: "loan", ref_id: uid() }), /must exist/);
      await rejects(insertTransaction(c, { ...e, ref_type: "recurring", ref_id: uid() }), /must exist/);
      await rejects(insertTransaction(c, { account_id: acc, transaction_type: "transfer_out", transfer_id: uid(), ref_type: "cc_bill", ref_id: uid() }), /must exist/);

      const loan = uid();
      await run("INSERT INTO app_loan (id, created_by, household_id, updated_by, name, account_id, category_id, monthly_payment_amount, total_terms, start_date) VALUES (?, ?, ?, ?, 'car', ?, ?, 1000, 12, '2026-01-05')", loan, c.owner, c.hh, c.owner, acc, exp.id);
      await insertTransaction(c, { ...e, ref_type: "loan", ref_id: loan });
      const other = await seedHousehold();
      await rejects(insertTransaction(other, { account_id: await seedAccount(other), transaction_type: "expense", category_id: (await seedCategory(other, "expense")).id, ref_type: "loan", ref_id: loan }), /must exist/);
    });
    it("trigger: ref check also runs on update", async () => {
      const c = await seedHousehold();
      const acc = await seedAccount(c);
      const exp = await seedCategory(c, "expense");
      const id = await insertTransaction(c, { account_id: acc, transaction_type: "expense", category_id: exp.id });
      await rejects(run("UPDATE app_transaction SET ref_type = 'loan', ref_id = ? WHERE id = ?", uid(), id), /must exist/);
    });
  });

  it("the listed partial indexes exist", async () => {
    const names = (await rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")).map((r) => r.name);
    for (const n of ["app_transaction_transfer_uq", "app_transaction_date_idx", "app_transaction_category_idx", "app_transaction_account_idx", "app_transaction_ref_idx"]) expect(names).toContain(n);
  });
});

describe("app_budget", () => {
  const ins = (c: { hh: string; owner: string }, over: Record<string, unknown> = {}) => {
    const v = { category_id: null, group_id: null, period_type: "monthly_cycle", start_date: "2026-11-01", end_date: null, amount: 500000, paid_offset: 0, ...over };
    return run("INSERT INTO app_budget (created_by, household_id, updated_by, category_id, group_id, period_type, start_date, end_date, amount, paid_offset) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", c.owner, c.hh, c.owner, v.category_id, v.group_id, v.period_type, v.start_date, v.end_date, v.amount, v.paid_offset);
  };
  it("valid monthly category budget, monthly group budget and date_range budget pass", async () => {
    const c = await seedHousehold();
    const cat = await seedCategory(c);
    const grp = await seedGroup(c);
    await ins(c, { category_id: cat.id });
    await ins(c, { group_id: grp });
    await ins(c, { category_id: cat.id, period_type: "date_range", end_date: "2026-12-31", paid_offset: 100 });
  });
  it("exactly one of category_id / group_id", async () => {
    const c = await seedHousehold();
    const cat = await seedCategory(c);
    await rejects(ins(c), /CHECK/);
    await rejects(ins(c, { category_id: cat.id, group_id: cat.groupId }), /CHECK/);
  });
  it("trigger: category and group must be expense", async () => {
    const c = await seedHousehold();
    const inc = await seedCategory(c, "income");
    await rejects(ins(c, { category_id: inc.id }), /expense group/);
    await rejects(ins(c, { group_id: inc.groupId }), /expense group/);
    const exp = await seedCategory(c, "expense");
    const id = uid();
    await run("INSERT INTO app_budget (id, created_by, household_id, updated_by, category_id, start_date, amount) VALUES (?, ?, ?, ?, ?, '2026-11-01', 1)", id, c.owner, c.hh, c.owner, exp.id);
    await rejects(run("UPDATE app_budget SET category_id = ? WHERE id = ?", inc.id, id), /expense group/);
  });
  it("one active monthly budget per category and per group; date_range and inactive rows are exempt", async () => {
    const c = await seedHousehold();
    const cat = await seedCategory(c);
    await ins(c, { category_id: cat.id });
    await rejects(ins(c, { category_id: cat.id }), /UNIQUE/);
    await ins(c, { category_id: cat.id, period_type: "date_range", end_date: "2026-12-31" });
    await run("UPDATE app_budget SET is_active = 0 WHERE category_id = ? AND period_type = 'monthly_cycle'", cat.id);
    await ins(c, { category_id: cat.id });
    const grp = await seedGroup(c);
    await ins(c, { group_id: grp });
    await rejects(ins(c, { group_id: grp }), /UNIQUE/);
  });
  it("period_type known; end_date required for date_range, NULL for monthly_cycle", async () => {
    const c = await seedHousehold();
    const cat = await seedCategory(c);
    await rejects(ins(c, { category_id: cat.id, period_type: "weekly" }), /CHECK/);
    await rejects(ins(c, { category_id: cat.id, period_type: "date_range" }), /CHECK/);
    await rejects(ins(c, { category_id: cat.id, end_date: "2026-12-31" }), /CHECK/);
  });
  it("dates are real; end_date >= start_date", async () => {
    const c = await seedHousehold();
    const cat = await seedCategory(c);
    await rejects(ins(c, { category_id: cat.id, start_date: "2026-02-30" }), /CHECK/);
    await rejects(ins(c, { category_id: cat.id, period_type: "date_range", end_date: "2026-13-01" }), /CHECK/);
    await rejects(ins(c, { category_id: cat.id, period_type: "date_range", end_date: "2026-10-31" }), /CHECK/);
  });
  it("amount > 0; paid_offset >= 0 and 0 for monthly_cycle", async () => {
    const c = await seedHousehold();
    const cat = await seedCategory(c);
    await rejects(ins(c, { category_id: cat.id, amount: 0 }), /CHECK/);
    await rejects(ins(c, { category_id: cat.id, paid_offset: -1 }), /CHECK/);
    await rejects(ins(c, { category_id: cat.id, paid_offset: 5 }), /CHECK/);
  });
});

describe("app_credit_card_bill", () => {
  const ins = (c: { hh: string; owner: string }, account: string, over: Record<string, unknown> = {}) => {
    const v = { date: "2026-11-15", amount: 1000000, minimum_payment: 0, ...over };
    return run('INSERT INTO app_credit_card_bill (created_by, household_id, updated_by, account_id, "date", amount, minimum_payment) VALUES (?, ?, ?, ?, ?, ?, ?)', c.owner, c.hh, c.owner, account, v.date, v.amount, v.minimum_payment);
  };
  it("valid insert passes", async () => {
    const c = await seedHousehold();
    await ins(c, await seedCard(c));
  });
  it("trigger: account must be a credit_card; account never changes", async () => {
    const c = await seedHousehold();
    await rejects(ins(c, await seedAccount(c)), /credit_card/);
    const card = await seedCard(c);
    await ins(c, card);
    await rejects(run("UPDATE app_credit_card_bill SET account_id = ? WHERE account_id = ?", await seedCard(c), card), /never changes/);
  });
  it("one active bill per (account, date)", async () => {
    const c = await seedHousehold();
    const card = await seedCard(c);
    await ins(c, card);
    await rejects(ins(c, card), /UNIQUE/);
    await run("UPDATE app_credit_card_bill SET is_active = 0 WHERE account_id = ?", card);
    await ins(c, card);
  });
  it("date real; amount > 0; minimum_payment between 0 and amount", async () => {
    const c = await seedHousehold();
    const card = await seedCard(c);
    await rejects(ins(c, card, { date: "2026-02-31" }), /CHECK/);
    await rejects(ins(c, card, { amount: 0 }), /CHECK/);
    await rejects(ins(c, card, { minimum_payment: -1 }), /CHECK/);
    await rejects(ins(c, card, { amount: 100, minimum_payment: 101 }), /CHECK/);
    await ins(c, card, { amount: 100, minimum_payment: 100, date: "2026-10-15" });
  });
});

describe("app_recurring_transaction", () => {
  const ins = async (c: { hh: string; owner: string }, over: Record<string, unknown> = {}) => {
    const v = { recurring_day: 5, name: `rec ${nextN()}`, amount: 0, auto_debit: 0, start_date: "2026-11-05", ...over };
    const category = (over.category_id as string) ?? (await seedCategory(c)).id;
    const account = (over.account_id as string) ?? (await seedAccount(c));
    return run("INSERT INTO app_recurring_transaction (created_by, household_id, updated_by, recurring_day, name, amount, category_id, account_id, auto_debit, start_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", c.owner, c.hh, c.owner, v.recurring_day, v.name, v.amount, category, account, v.auto_debit, v.start_date);
  };
  it("valid insert passes (amount 0 = varies); income category allowed", async () => {
    const c = await seedHousehold();
    await ins(c);
    await ins(c, { category_id: (await seedCategory(c, "income")).id, amount: 5000000 });
  });
  it("recurring_day 1..31; amount >= 0; auto_debit 0/1; start_date real", async () => {
    const c = await seedHousehold();
    await rejects(ins(c, { recurring_day: 0 }), /CHECK/);
    await rejects(ins(c, { recurring_day: 32 }), /CHECK/);
    await rejects(ins(c, { amount: -1 }), /CHECK/);
    await rejects(ins(c, { auto_debit: 2 }), /CHECK/);
    await rejects(ins(c, { start_date: "2026-04-31" }), /CHECK/);
  });
  it("name rules; unique while active", async () => {
    const c = await seedHousehold();
    await rejects(ins(c, { name: "" }), /CHECK/);
    await rejects(ins(c, { name: "a".repeat(101) }), /CHECK/);
    await ins(c, { name: "Rent" });
    await rejects(ins(c, { name: "rent" }), /UNIQUE/);
  });
  it("FK: category and account of the same household", async () => {
    const a = await seedHousehold();
    const b = await seedHousehold();
    await rejects(ins(a, { account_id: await seedAccount(b) }), /FOREIGN KEY/);
    await rejects(ins(a, { category_id: (await seedCategory(b)).id }), /FOREIGN KEY/);
  });
});

describe("app_loan", () => {
  const ins = async (c: { hh: string; owner: string }, over: Record<string, unknown> = {}) => {
    const v = { name: `loan ${nextN()}`, interest_rate: 0, monthly_payment_amount: 1000, total_terms: 12, terms_paid_offset: 0, start_date: "2026-01-05", ...over };
    const category = (over.category_id as string) ?? (await seedCategory(c)).id;
    const account = (over.account_id as string) ?? (await seedAccount(c));
    return run("INSERT INTO app_loan (created_by, household_id, updated_by, name, account_id, category_id, interest_rate, monthly_payment_amount, total_terms, terms_paid_offset, start_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", c.owner, c.hh, c.owner, v.name, account, category, v.interest_rate, v.monthly_payment_amount, v.total_terms, v.terms_paid_offset, v.start_date);
  };
  it("valid insert passes", async () => {
    const c = await seedHousehold();
    await ins(c, { interest_rate: 7.5, terms_paid_offset: 12 });
  });
  it("trigger: category must belong to an expense group (insert and update)", async () => {
    const c = await seedHousehold();
    const inc = await seedCategory(c, "income");
    await rejects(ins(c, { category_id: inc.id }), /expense group/);
    await ins(c, { name: "mover" });
    await rejects(run("UPDATE app_loan SET category_id = ? WHERE name = 'mover' AND household_id = ?", inc.id, c.hh), /expense group/);
  });
  it("interest_rate >= 0; payment > 0; terms > 0; offset between 0 and total_terms", async () => {
    const c = await seedHousehold();
    await rejects(ins(c, { interest_rate: -0.1 }), /CHECK/);
    await rejects(ins(c, { monthly_payment_amount: 0 }), /CHECK/);
    await rejects(ins(c, { total_terms: 0 }), /CHECK/);
    await rejects(ins(c, { terms_paid_offset: -1 }), /CHECK/);
    await rejects(ins(c, { terms_paid_offset: 13 }), /CHECK/);
  });
  it("name rules; unique while active; start_date real", async () => {
    const c = await seedHousehold();
    await rejects(ins(c, { name: "" }), /CHECK/);
    await rejects(ins(c, { start_date: "2026-02-30" }), /CHECK/);
    await ins(c, { name: "House" });
    await rejects(ins(c, { name: "house" }), /UNIQUE/);
  });
});

describe("app_household_setting", () => {
  it("defaults come from the table", async () => {
    const c = await seedHousehold();
    expect(await row("SELECT cycle_start_day, savings_target_amount, savings_target_metrics, timezone FROM app_household_setting WHERE household_id = ?", c.hh)).toEqual({
      cycle_start_day: 1, savings_target_amount: 0, savings_target_metrics: "net_balance", timezone: "Asia/Jakarta",
    });
  });
  it("one row per household; household must exist", async () => {
    const c = await seedHousehold();
    await rejects(run("INSERT INTO app_household_setting (household_id, updated_by) VALUES (?, ?)", c.hh, c.owner), /UNIQUE|PRIMARY/);
    await rejects(run("INSERT INTO app_household_setting (household_id, updated_by) VALUES (?, ?)", uid(), c.owner), /FOREIGN KEY/);
  });
  it("cycle_start_day 1..31; savings_target_amount >= 0; metrics known; timezone not empty", async () => {
    const c = await seedHousehold();
    await rejects(run("UPDATE app_household_setting SET cycle_start_day = 0 WHERE household_id = ?", c.hh), /CHECK/);
    await rejects(run("UPDATE app_household_setting SET cycle_start_day = 32 WHERE household_id = ?", c.hh), /CHECK/);
    await rejects(run("UPDATE app_household_setting SET savings_target_amount = -1 WHERE household_id = ?", c.hh), /CHECK/);
    await rejects(run("UPDATE app_household_setting SET savings_target_metrics = 'profit' WHERE household_id = ?", c.hh), /CHECK/);
    await rejects(run("UPDATE app_household_setting SET timezone = '' WHERE household_id = ?", c.hh), /CHECK/);
    await run("UPDATE app_household_setting SET cycle_start_day = 25, savings_target_metrics = 'net_worth', timezone = 'Asia/Tokyo' WHERE household_id = ?", c.hh);
  });
  it("trigger: updated_by's current household must be this household; FK needs a member row", async () => {
    const a = await seedHousehold();
    const b = await seedHousehold();
    await rejects(run("UPDATE app_household_setting SET updated_by = ? WHERE household_id = ?", b.owner, a.hh), /FOREIGN KEY|updated_by/);
    await run("INSERT INTO tenant_household_member (household_id, user_id) VALUES (?, ?)", b.hh, a.owner);
    await run("UPDATE tenant_user SET household_id = ? WHERE id = ?", b.hh, a.owner);
    await rejects(run("UPDATE app_household_setting SET savings_target_amount = 5 WHERE household_id = ?", a.hh), /updated_by must currently/);
  });
});

describe("schema inventory", () => {
  it("has the 17 tables from table_design", async () => {
    const names = (await rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'tenant_%' OR type = 'table' AND name LIKE 'app_%' ORDER BY name")).map((r) => r.name);
    expect(names).toEqual([
      "app_budget", "app_credit_card_bill", "app_financial_account", "app_household_setting", "app_loan", "app_recurring_transaction",
      "app_transaction", "app_transaction_category", "app_transaction_group",
      "tenant_household", "tenant_household_member", "tenant_user", "tenant_user_email_verification", "tenant_user_invite",
      "tenant_user_login", "tenant_user_password_reset", "tenant_user_session",
    ]);
  });
});
