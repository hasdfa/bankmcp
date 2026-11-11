import { test } from "node:test";
import assert from "node:assert/strict";
import { WiseClient } from "../src/wise.ts";

const amount = (value: number) => ({ value, currency: "EUR" });
const jar = { id: 12, currency: "EUR", type: "SAVINGS", name: "Investments", investmentState: "INVESTED", amount: amount(80), reservedAmount: amount(2), cashAmount: amount(3), totalWorth: amount(100), providerExtra: { retained: true } };

function fixture(body: unknown, status = 200, headers?: HeadersInit) {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const request: typeof fetch = async (input, init) => {
    requests.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify(body), { status, headers });
  };
  return { client: new WiseClient("secret-token", request), requests };
}

test("reads both profile types and preserves provider metadata", async () => {
  const profiles = [{ id: 1, type: "personal", details: { firstName: "Example" } }, { id: 2, type: "business", details: { name: "Example Ltd" } }];
  const { client, requests } = fixture(profiles);
  assert.deepEqual(await client.listProfiles(), profiles);
  assert.equal(requests[0]!.url.href, "https://api.wise.com/2026Q4/profiles");
  assert.equal(requests[0]!.init!.method, "GET");
  assert.equal(requests[0]!.init!.redirect, "error");
  assert.equal(new Headers(requests[0]!.init!.headers).get("Authorization"), "Bearer secret-token");
  assert.ok(requests[0]!.init!.signal instanceof AbortSignal);
});

test("requests STANDARD and SAVINGS without merging same-currency jars or dropping invested balances", async () => {
  const balances = [{ ...jar, id: 11, type: "STANDARD", name: null }, jar, { ...jar, id: 13, name: "Tax", investmentState: "NOT_INVESTED" }];
  const { client, requests } = fixture(balances);
  assert.deepEqual(await client.listBalances(1), balances);
  assert.equal(requests[0]!.url.searchParams.get("types"), "STANDARD,SAVINGS");
  assert.equal(requests[0]!.url.pathname, "/2026Q4/profiles/1/balances");
});

test("reads a jar by its profile and balance IDs", async () => {
  const { client, requests } = fixture(jar);
  assert.deepEqual(await client.getBalance(2, 12), jar);
  assert.equal(requests[0]!.url.pathname, "/2026Q4/profiles/2/balances/12");
});

test("statements retain interest, trades, fees, signed amounts and unknown fields", async () => {
  const statement = { transactions: [
    { referenceNumber: "a", type: "CREDIT", amount: amount(2), details: { type: "BALANCE_INTEREST" } },
    { referenceNumber: "b", type: "DEBIT", amount: amount(-10), totalFees: amount(1), details: { type: "INVESTMENT_TRADE_ORDER", extra: "retained" } },
  ], endOfStatementBalance: amount(92), extra: true };
  const { client, requests } = fixture(statement);
  assert.deepEqual(await client.getStatement(1, 12, "EUR", "2025-01-01", "2026-01-01"), statement);
  const query = requests[0]!.url.searchParams;
  assert.equal(query.get("intervalStart"), "2025-01-01T00:00:00.000Z");
  assert.equal(query.get("intervalEnd"), "2026-01-01T23:59:59.999Z");
  assert.equal(query.get("type"), "COMPACT");
});

test("invalid IDs and statement ranges fail before any network request", async () => {
  const { client, requests } = fixture({ transactions: [] });
  for (const id of [-1, 0, 1.2, Number.MAX_SAFE_INTEGER + 1, NaN]) await assert.rejects(client.listBalances(id));
  for (const [from, to] of [["2025-02-30", "2025-03-01"], ["2026-01-02", "2026-01-01"], ["2020-01-01", "2026-01-01"], ["2025-1-1", "2025-02-01"]]) {
    await assert.rejects(client.getStatement(1, 12, "EUR", from!, to!));
  }
  await assert.rejects(client.getStatement(1, 12, "../", "2025-01-01", "2025-01-02"));
  assert.equal(requests.length, 0);
});

test("API errors never echo upstream bodies or authentication headers", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const { client } = fixture({ error: "secret-token private-account-data" }, status);
    await assert.rejects(client.listProfiles(), (err: Error) => {
      assert.match(err.message, new RegExp(String(status)));
      assert.doesNotMatch(err.message, /secret-token|private-account-data/);
      return true;
    });
  }
});

test("SCA denial is an explicit limitation, never an empty statement", async () => {
  const { client } = fixture({}, 403, { "x-2fa-approval": "private-challenge", "x-2fa-approval-result": "REJECTED" });
  await assert.rejects(client.getStatement(1, 12, "EUR", "2025-01-01", "2025-01-02"), /Strong Customer Authentication/);
});

test("malformed provider data and network errors fail without leaking response data", async () => {
  await assert.rejects(fixture({ secret: "secret-token" }).client.listBalances(1), /unexpected response/);
  const request: typeof fetch = async () => { throw new Error("secret-token network details"); };
  await assert.rejects(new WiseClient("secret-token", request).listProfiles(), (err: Error) => {
    assert.doesNotMatch(err.message, /secret-token|network details/);
    return true;
  });
});
