import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCustomAccounts } from "../src/custom-accounts.ts";

function file(text: string) {
  const path = join(mkdtempSync(join(tmpdir(), "custom-accounts-")), "accounts.yaml");
  writeFileSync(path, text);
  return path;
}

test("loads YAML labels, descriptions and inline or environment credentials", () => {
  const path = file(`accounts:
  - label: Business
    description: Business banking
    provider: wise
    config:
      api_key: inline-secret
  - label: Personal
    description: Personal banking
    provider: wise
    config:
      api_key_env: WISE_PERSONAL_KEY
`);
  assert.deepEqual(readCustomAccounts(path, { WISE_PERSONAL_KEY: "env-secret" }).map((a) => [a.label, a.config.api_key]), [["Business", "inline-secret"], ["Personal", "env-secret"]]);
  assert.deepEqual(readCustomAccounts(""), []);
  assert.deepEqual(readCustomAccounts(file("accounts: []")), []);
});

test("invalid configuration fails without printing secrets or YAML source", () => {
  const account = { label: "Business", description: "Business banking", provider: "wise", config: { api_key: "secret-must-not-leak" } };
  const invalid = [
    "accounts: [secret-must-not-leak",
    JSON.stringify({ accounts: [account, { ...account, label: "business" }] }),
    JSON.stringify({ accounts: [{ ...account, provider: "unknown" }] }),
    JSON.stringify({ accounts: [{ ...account, description: "" }] }),
    JSON.stringify({ accounts: [{ ...account, config: { api_key: "secret-must-not-leak", api_key_env: "BOTH" } }] }),
    JSON.stringify({ accounts: [{ ...account, config: { api_key_env: "MISSING" } }] }),
    JSON.stringify({ accounts: [{ ...account, config: { api_key: "secret-must-not-leak", base_url: "https://example.com" } }] }),
    "accounts: []\naccounts: secret-must-not-leak",
    "accounts: &a [*a]",
  ];
  for (const contents of invalid) assert.throws(() => readCustomAccounts(file(contents), {}), (err: Error) => {
    assert.match(err.message, /Invalid CUSTOM_ACCOUNTS_FILE/);
    assert.doesNotMatch(err.message, /secret-must-not-leak/);
    return true;
  });
});
