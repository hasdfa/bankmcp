import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { z } from "zod";

const accountSchema = z.object({
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(1000),
  provider: z.literal("wise"),
  config: z.object({
    api_key: z.string().trim().min(1).optional(),
    api_key_env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  }).strict().refine((c) => Boolean(c.api_key) !== Boolean(c.api_key_env)),
}).strict();
const fileSchema = z.object({ accounts: z.array(accountSchema) }).strict();

export interface CustomAccount {
  label: string;
  description: string;
  provider: "wise";
  config: { api_key: string };
}

export function readCustomAccounts(path: string, env: NodeJS.ProcessEnv = process.env): CustomAccount[] {
  if (!path) return [];
  let parsed: z.infer<typeof fileSchema>;
  try {
    const document = parseDocument(readFileSync(path, "utf8"), { uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error();
    parsed = fileSchema.parse(document.toJS({ maxAliasCount: 0 }));
  } catch {
    // YAML/Zod diagnostics can contain literal credentials. Never surface them.
    throw new Error("Invalid CUSTOM_ACCOUNTS_FILE: expected accounts with label, description, provider: wise, and config containing exactly one of api_key or api_key_env. Check file access and YAML syntax; aliases are not supported.");
  }
  const labels = new Set<string>();
  return parsed.accounts.map((account) => {
    const normalized = account.label.toLowerCase();
    if (labels.has(normalized)) throw new Error("Invalid CUSTOM_ACCOUNTS_FILE: account labels must be unique (case-insensitive).");
    labels.add(normalized);
    const key = account.config.api_key ?? env[account.config.api_key_env!]?.trim();
    if (!key) throw new Error("Invalid CUSTOM_ACCOUNTS_FILE: a referenced API key environment variable is empty or missing.");
    return { label: account.label, description: account.description, provider: account.provider, config: { api_key: key } };
  });
}

let cached: { path: string; accounts: CustomAccount[] } | undefined;

/** A configuration snapshot: restart after editing YAML or rotating credentials. */
export function customAccounts(): CustomAccount[] {
  const path = process.env.CUSTOM_ACCOUNTS_FILE ?? "";
  if (cached?.path !== path) cached = { path, accounts: readCustomAccounts(path) };
  return cached.accounts;
}
