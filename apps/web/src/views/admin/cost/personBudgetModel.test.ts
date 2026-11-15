/**
 * Spend by person (UI-D D3): the standing mirrors the gateway's crossing rule, the form checks refuse what the
 * gateway refuses before anything is sent, and the picker never offers a person who already has a budget.
 */
import { describe, expect, it } from "vitest";
import {
  amountProblem,
  budgetBody,
  budgetLine,
  matchesName,
  pctWords,
  peopleWithoutBudget,
  periodWords,
  standing,
  thresholdProblem,
} from "./personBudgetModel";

const view = (spent: number, budgetUsd = 100, alertThresholdPct = 80) => ({
  metered: { basis: "metered" as const, usd: spent, pctOfBudget: (spent / budgetUsd) * 100 },
  budget: { id: "b", userId: "u", budgetUsd, budgetPeriod: "monthly", alertThresholdPct },
});

describe("standing", () => {
  it("is below, alerting at the threshold, and over at the budget, matching the gateway's crossing rule", () => {
    expect(standing(view(79.99))).toBe("below");
    expect(standing(view(80))).toBe("alerting");
    expect(standing(view(99.99))).toBe("alerting");
    expect(standing(view(100))).toBe("over");
    expect(standing(view(250))).toBe("over");
  });
  it("follows the person's own threshold", () => {
    expect(standing(view(50, 100, 50))).toBe("alerting");
    expect(standing(view(50, 100, 51))).toBe("below");
  });
});

describe("form checks", () => {
  it("refuses an empty, non-numeric, zero or too-large amount, and more than two decimals", () => {
    expect(amountProblem("")).toMatch(/Enter an amount/);
    expect(amountProblem("abc")).toMatch(/digits only/);
    expect(amountProblem("1.234")).toMatch(/two decimal/);
    expect(amountProblem("0")).toMatch(/more than zero/);
    expect(amountProblem("10000000.01")).toMatch(/at most/);
    // controls: valid amounts pass
    expect(amountProblem("500")).toBeNull();
    expect(amountProblem(" 12.50 ")).toBeNull();
    expect(amountProblem("10000000")).toBeNull();
  });
  it("takes a whole threshold from 1 to 100 only", () => {
    expect(thresholdProblem("0")).not.toBeNull();
    expect(thresholdProblem("101")).not.toBeNull();
    expect(thresholdProblem("50.5")).not.toBeNull();
    expect(thresholdProblem("")).not.toBeNull();
    expect(thresholdProblem("1")).toBeNull();
    expect(thresholdProblem("100")).toBeNull();
  });
  it("builds exactly the body the gateway accepts", () => {
    expect(budgetBody(" 500 ", "monthly", "80")).toEqual({ budgetUsd: 500, budgetPeriod: "monthly", alertThresholdPct: 80 });
    expect(Object.keys(budgetBody("1", "none", "100")).sort()).toEqual(["alertThresholdPct", "budgetPeriod", "budgetUsd"]);
  });
});

describe("words", () => {
  it("says the budget, window and threshold in words", () => {
    expect(budgetLine({ budgetUsd: 500, budgetPeriod: "monthly", alertThresholdPct: 80 })).toBe("$500 a month, alert at 80%");
    expect(budgetLine({ budgetUsd: 500, budgetPeriod: "none", alertThresholdPct: 90 })).toBe("$500 in total, alert at 90%");
    expect(periodWords("monthly")).toBe("Per calendar month (UTC)");
    expect(periodWords("none")).toBe("Lifetime, never resets");
  });
  it("rounds the percentage down, so a figure never reads as past a line it has not crossed", () => {
    expect(pctWords(79.99)).toBe("79% of the budget");
    expect(pctWords(-3)).toBe("0% of the budget");
  });
});

describe("people", () => {
  it("offers only people without a budget, by name", () => {
    const users = [
      { id: "c", displayName: "Cara" },
      { id: "a", displayName: "Avery" },
      { id: "b", displayName: "Bo" },
    ];
    expect(peopleWithoutBudget(users, [{ userId: "b" }]).map((u) => u.id)).toEqual(["a", "c"]);
  });
  it("filters by a case-insensitive part of the name, and an empty filter keeps everyone", () => {
    expect(matchesName({ displayName: "Avery Approver" }, "approv")).toBe(true);
    expect(matchesName({ displayName: "Avery Approver" }, "dana")).toBe(false);
    expect(matchesName({ displayName: null }, "  ")).toBe(true);
  });
});
