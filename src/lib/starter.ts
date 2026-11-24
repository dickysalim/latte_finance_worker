/** Starter list v1 (story 12): groups with their categories. Created with every new household. */
export const STARTER_GROUPS: { name: string; type: "expense" | "income"; categories: string[] }[] = [
  { name: "Food", type: "expense", categories: ["groceries", "eating out", "coffee"] },
  { name: "Home", type: "expense", categories: ["rent", "utilities", "internet"] },
  { name: "Transport", type: "expense", categories: ["fuel", "public transport", "parking"] },
  { name: "Health", type: "expense", categories: ["doctor", "pharmacy", "insurance"] },
  { name: "Shopping", type: "expense", categories: ["clothes", "household items"] },
  { name: "Fun", type: "expense", categories: ["subscriptions", "entertainment", "travel"] },
  { name: "Other", type: "expense", categories: ["other expense"] },
  { name: "Income", type: "income", categories: ["salary", "bonus", "other income"] },
];
