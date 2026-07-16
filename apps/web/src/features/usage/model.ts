// Display-safe usage projection. OMP remains the authority: this module only
// accepts the normalized `usage.read` result, bounds every collection/value,
// drops provider-specific metadata, and explicitly refuses the heavyweight
// `raw` field before anything reaches React state.

export const USAGE_UNITS = [
  "percent",
  "tokens",
  "requests",
  "usd",
  "minutes",
  "bytes",
  "unknown",
] as const;
export type UsageUnit = (typeof USAGE_UNITS)[number];

export const USAGE_STATUSES = ["ok", "warning", "exhausted", "unknown"] as const;
export type UsageStatus = (typeof USAGE_STATUSES)[number];

export interface UsageWindow {
  readonly id: string;
  readonly label: string;
  readonly durationMs?: number;
  readonly resetsAt?: number;
}

export interface UsageAmount {
  readonly used?: number;
  readonly limit?: number;
  readonly remaining?: number;
  readonly usedFraction?: number;
  readonly remainingFraction?: number;
  readonly unit: UsageUnit;
}

export interface UsageScope {
  readonly provider: string;
  readonly accountId?: string;
  readonly projectId?: string;
  readonly orgId?: string;
  readonly modelId?: string;
  readonly tier?: string;
  readonly windowId?: string;
  readonly shared?: boolean;
}

export interface UsageLimit {
  readonly id: string;
  readonly label: string;
  readonly scope: UsageScope;
  readonly window?: UsageWindow;
  readonly amount: UsageAmount;
  readonly status?: UsageStatus;
  readonly notes?: readonly string[];
}

export interface UsageResetCreditDetail {
  readonly grantedAt?: string;
  readonly expiresAt?: string;
  readonly status?: string;
}

export interface UsageResetCredits {
  readonly availableCount: number;
  readonly credits?: readonly UsageResetCreditDetail[];
}

/** The only report metadata T4 retains. Arbitrary provider metadata is dropped. */
export interface UsageReportIdentity {
  readonly email?: string;
  readonly accountId?: string;
  readonly projectId?: string;
  readonly orgId?: string;
  readonly orgName?: string;
  readonly planType?: string;
}

export interface UsageReport {
  readonly provider: string;
  readonly fetchedAt: number;
  readonly limits: readonly UsageLimit[];
  readonly resetCredits?: UsageResetCredits;
  readonly notes?: readonly string[];
  readonly identity: UsageReportIdentity;
}

export interface UsageAccountIdentity {
  readonly provider: string;
  readonly type: "api_key" | "oauth";
  readonly email?: string;
  readonly accountId?: string;
  readonly projectId?: string;
  readonly enterpriseUrl?: string;
  readonly orgId?: string;
  readonly orgName?: string;
}

export interface ProviderWindowStat {
  readonly window: string;
  readonly durationMs?: number;
  readonly accounts: number;
  readonly usedAccounts: number;
  readonly remainingAccounts: number;
}

export interface UsageSnapshot {
  readonly generatedAt: number;
  readonly reports: readonly UsageReport[];
  readonly accountsWithoutUsage: readonly UsageAccountIdentity[];
  readonly capacity: Readonly<Record<string, readonly ProviderWindowStat[]>>;
}

export interface UsageProviderGroup {
  readonly provider: string;
  readonly reports: readonly UsageReport[];
  readonly accountsWithoutUsage: readonly UsageAccountIdentity[];
  readonly capacity: readonly ProviderWindowStat[];
}

const MAX_RESULT_BYTES = 512 * 1024;
const MAX_REPORTS = 64;
const MAX_LIMITS_PER_REPORT = 32;
const MAX_CAPACITY_ACCOUNTS = MAX_REPORTS * MAX_LIMITS_PER_REPORT;
const MAX_ACCOUNTS_WITHOUT_USAGE = 128;
const MAX_CAPACITY_PROVIDERS = 64;
const MAX_CAPACITY_WINDOWS = 32;
const MAX_NOTES = 8;
const MAX_CREDITS = 64;
const MAX_TEXT = 2_048;
const MAX_IDENTITY_TEXT = 512;
const MAX_AMOUNT = 1_000_000_000_000_000;
const MAX_EPOCH_MS = 8_640_000_000_000_000;
const MAX_DURATION_MS = 315_576_000_000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
const CONTROL_CHARS = /\p{Cc}/u;

function fail(path: string, detail: string): never {
  throw new Error(`Invalid usage data at ${path}: ${detail}.`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "expected a plain object");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string, max: number): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  if (value.length > max) fail(path, `contains more than ${max} entries`);
  return value;
}

function text(value: unknown, path: string, max = MAX_TEXT): string {
  if (typeof value !== "string") fail(path, "expected text");
  if (value.length === 0) fail(path, "must not be empty");
  if (new TextEncoder().encode(value).byteLength > max) fail(path, `exceeds ${max} UTF-8 bytes`);
  if (CONTROL_CHARS.test(value)) fail(path, "contains control characters");
  return value;
}

function optionalText(value: unknown, path: string, max = MAX_IDENTITY_TEXT): string | undefined {
  return value === undefined ? undefined : text(value, path, max);
}

function nonnegativeNumber(value: unknown, path: string, max = MAX_AMOUNT): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    fail(path, "expected a bounded non-negative number");
  }
  return value;
}

function amountNumber(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < -MAX_AMOUNT ||
    value > MAX_AMOUNT
  ) {
    fail(path, "expected a bounded number");
  }
  return value;
}

function optionalNumber(value: unknown, path: string, max = MAX_AMOUNT): number | undefined {
  return value === undefined ? undefined : nonnegativeNumber(value, path, max);
}

function integer(value: unknown, path: string, max: number): number {
  const number = nonnegativeNumber(value, path, max);
  if (!Number.isSafeInteger(number)) fail(path, "expected a safe integer");
  return number;
}

function epoch(value: unknown, path: string): number {
  return integer(value, path, MAX_EPOCH_MS);
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  path: string,
  values: T,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    fail(path, `expected one of ${values.join(", ")}`);
  }
  return value as T[number];
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") fail(path, "expected true or false");
  return value;
}

function notes(value: unknown, path: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  return Object.freeze(array(value, path, MAX_NOTES).map((entry, index) => text(entry, `${path}[${index}]`)));
}

function windowFrom(value: unknown, path: string): UsageWindow {
  const input = record(value, path);
  const durationMs = optionalNumber(input.durationMs, `${path}.durationMs`, MAX_DURATION_MS);
  const resetsAt = input.resetsAt === undefined ? undefined : epoch(input.resetsAt, `${path}.resetsAt`);
  return Object.freeze({
    id: text(input.id, `${path}.id`, 256),
    label: text(input.label, `${path}.label`, 256),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  });
}

function amountFrom(value: unknown, path: string): UsageAmount {
  const input = record(value, path);
  const optionalAmount = (value: unknown, field: string): number | undefined =>
    value === undefined ? undefined : amountNumber(value, `${path}.${field}`);
  const used = optionalAmount(input.used, "used");
  const limit = optionalAmount(input.limit, "limit");
  const remaining = optionalAmount(input.remaining, "remaining");
  const usedFraction = optionalAmount(input.usedFraction, "usedFraction");
  const remainingFraction = optionalAmount(input.remainingFraction, "remainingFraction");
  return Object.freeze({
    ...(used === undefined ? {} : { used }),
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(usedFraction === undefined ? {} : { usedFraction }),
    ...(remainingFraction === undefined ? {} : { remainingFraction }),
    unit: enumValue(input.unit, `${path}.unit`, USAGE_UNITS),
  });
}

function scopeFrom(value: unknown, path: string, provider: string): UsageScope {
  const input = record(value, path);
  const scopeProvider = text(input.provider, `${path}.provider`, 128);
  if (scopeProvider !== provider) fail(`${path}.provider`, "does not match its report provider");
  const accountId = optionalText(input.accountId, `${path}.accountId`);
  const projectId = optionalText(input.projectId, `${path}.projectId`);
  const orgId = optionalText(input.orgId, `${path}.orgId`);
  const modelId = optionalText(input.modelId, `${path}.modelId`);
  const tier = optionalText(input.tier, `${path}.tier`, 256);
  const windowId = optionalText(input.windowId, `${path}.windowId`, 256);
  const shared = optionalBoolean(input.shared, `${path}.shared`);
  return Object.freeze({
    provider,
    ...(accountId === undefined ? {} : { accountId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(orgId === undefined ? {} : { orgId }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(tier === undefined ? {} : { tier }),
    ...(windowId === undefined ? {} : { windowId }),
    ...(shared === undefined ? {} : { shared }),
  });
}

function limitFrom(value: unknown, path: string, provider: string): UsageLimit {
  const input = record(value, path);
  const status =
    input.status === undefined
      ? undefined
      : enumValue(input.status, `${path}.status`, USAGE_STATUSES);
  const usageWindow = input.window === undefined ? undefined : windowFrom(input.window, `${path}.window`);
  const limitNotes = notes(input.notes, `${path}.notes`);
  return Object.freeze({
    id: text(input.id, `${path}.id`, 256),
    label: text(input.label, `${path}.label`, 512),
    scope: scopeFrom(input.scope, `${path}.scope`, provider),
    ...(usageWindow === undefined ? {} : { window: usageWindow }),
    amount: amountFrom(input.amount, `${path}.amount`),
    ...(status === undefined ? {} : { status }),
    ...(limitNotes === undefined ? {} : { notes: limitNotes }),
  });
}

function isoDate(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  const date = text(value, path, 128);
  if (!Number.isFinite(Date.parse(date))) fail(path, "expected an ISO date");
  return date;
}

function resetCreditsFrom(value: unknown, path: string): UsageResetCredits {
  const input = record(value, path);
  const rawCredits = input.credits;
  const credits =
    rawCredits === undefined
      ? undefined
      : Object.freeze(
          array(rawCredits, `${path}.credits`, MAX_CREDITS).map((entry, index) => {
            const creditPath = `${path}.credits[${index}]`;
            const credit = record(entry, creditPath);
            const grantedAt = isoDate(credit.grantedAt, `${creditPath}.grantedAt`);
            const expiresAt = isoDate(credit.expiresAt, `${creditPath}.expiresAt`);
            const status = optionalText(credit.status, `${creditPath}.status`, 128);
            return Object.freeze({
              ...(grantedAt === undefined ? {} : { grantedAt }),
              ...(expiresAt === undefined ? {} : { expiresAt }),
              ...(status === undefined ? {} : { status }),
            });
          }),
        );
  return Object.freeze({
    availableCount: integer(input.availableCount, `${path}.availableCount`, MAX_CREDITS),
    ...(credits === undefined ? {} : { credits }),
  });
}

function reportIdentityFrom(value: unknown, path: string): UsageReportIdentity {
  if (value === undefined) return Object.freeze({});
  const input = record(value, path);
  const email = optionalText(input.email, `${path}.email`, 320);
  const accountId = optionalText(input.accountId, `${path}.accountId`);
  const projectId = optionalText(input.projectId, `${path}.projectId`);
  const orgId = optionalText(input.orgId, `${path}.orgId`);
  const orgName = optionalText(input.orgName, `${path}.orgName`, 256);
  const planType = optionalText(input.planType, `${path}.planType`, 128);
  return Object.freeze({
    ...(email === undefined ? {} : { email }),
    ...(accountId === undefined ? {} : { accountId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(orgId === undefined ? {} : { orgId }),
    ...(orgName === undefined ? {} : { orgName }),
    ...(planType === undefined ? {} : { planType }),
  });
}

function reportFrom(value: unknown, path: string): UsageReport {
  const input = record(value, path);
  if (Object.hasOwn(input, "raw")) fail(`${path}.raw`, "provider raw payloads are forbidden");
  const provider = text(input.provider, `${path}.provider`, 128);
  const reportNotes = notes(input.notes, `${path}.notes`);
  const resetCredits =
    input.resetCredits === undefined
      ? undefined
      : resetCreditsFrom(input.resetCredits, `${path}.resetCredits`);
  const limits = array(input.limits, `${path}.limits`, MAX_LIMITS_PER_REPORT).map(
    (limit, index) => limitFrom(limit, `${path}.limits[${index}]`, provider),
  );
  const ids = new Set<string>();
  for (const [index, limit] of limits.entries()) {
    if (ids.has(limit.id)) fail(`${path}.limits[${index}].id`, "must be unique within a report");
    ids.add(limit.id);
  }
  return Object.freeze({
    provider,
    fetchedAt: epoch(input.fetchedAt, `${path}.fetchedAt`),
    limits: Object.freeze(limits),
    ...(resetCredits === undefined ? {} : { resetCredits }),
    ...(reportNotes === undefined ? {} : { notes: reportNotes }),
    identity: reportIdentityFrom(input.metadata, `${path}.metadata`),
  });
}

function enterpriseOrigin(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  const candidate = text(value, path, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    fail(path, "expected a valid HTTP URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    fail(path, "expected an HTTP URL without credentials or parameters");
  }
  return candidate;
}

function accountFrom(value: unknown, path: string): UsageAccountIdentity {
  const input = record(value, path);
  const email = optionalText(input.email, `${path}.email`, 320);
  const accountId = optionalText(input.accountId, `${path}.accountId`);
  const projectId = optionalText(input.projectId, `${path}.projectId`);
  const enterpriseUrl = enterpriseOrigin(input.enterpriseUrl, `${path}.enterpriseUrl`);
  const orgId = optionalText(input.orgId, `${path}.orgId`);
  const orgName = optionalText(input.orgName, `${path}.orgName`, 256);
  return Object.freeze({
    provider: text(input.provider, `${path}.provider`, 128),
    type: enumValue(input.type, `${path}.type`, ["api_key", "oauth"] as const),
    ...(email === undefined ? {} : { email }),
    ...(accountId === undefined ? {} : { accountId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(enterpriseUrl === undefined ? {} : { enterpriseUrl }),
    ...(orgId === undefined ? {} : { orgId }),
    ...(orgName === undefined ? {} : { orgName }),
  });
}

function capacityFrom(value: unknown, path: string): UsageSnapshot["capacity"] {
  const input = record(value, path);
  const entries = Object.entries(input);
  if (entries.length > MAX_CAPACITY_PROVIDERS) {
    fail(path, `contains more than ${MAX_CAPACITY_PROVIDERS} providers`);
  }
  // Provider ids are broker input. A null-prototype record keeps values such
  // as `__proto__` inert instead of letting them alter this lookup object's
  // prototype before it reaches renderer state.
  const output = Object.create(null) as Record<string, readonly ProviderWindowStat[]>;
  for (const [rawProvider, rawStats] of entries) {
    const provider = text(rawProvider, `${path} provider`, 128);
    output[provider] = Object.freeze(
      array(rawStats, `${path}.${provider}`, MAX_CAPACITY_WINDOWS).map((entry, index) => {
        const statPath = `${path}.${provider}[${index}]`;
        const inputStat = record(entry, statPath);
        const accounts = integer(
          inputStat.accounts,
          `${statPath}.accounts`,
          MAX_CAPACITY_ACCOUNTS,
        );
        const durationMs = optionalNumber(
          inputStat.durationMs,
          `${statPath}.durationMs`,
          Number.MAX_SAFE_INTEGER,
        );
        return Object.freeze({
          window: text(inputStat.window, `${statPath}.window`, 256),
          ...(durationMs === undefined ? {} : { durationMs }),
          accounts,
          usedAccounts: nonnegativeNumber(inputStat.usedAccounts, `${statPath}.usedAccounts`, accounts),
          remainingAccounts: nonnegativeNumber(
            inputStat.remainingAccounts,
            `${statPath}.remainingAccounts`,
            accounts,
          ),
        });
      }),
    );
  }
  return Object.freeze(output);
}

/** Decode and sanitize one `usage.read` result. Throws display-safe errors. */
export function decodeUsageSnapshot(value: unknown): UsageSnapshot {
  const input = record(value, "result");
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    fail("result", "must be JSON serializable");
  }
  if (new TextEncoder().encode(encoded).byteLength > MAX_RESULT_BYTES) {
    fail("result", `exceeds ${MAX_RESULT_BYTES} UTF-8 bytes`);
  }
  const reports = Object.freeze(
    array(input.reports, "result.reports", MAX_REPORTS).map((report, index) =>
      reportFrom(report, `result.reports[${index}]`),
    ),
  );
  return Object.freeze({
    generatedAt: epoch(input.generatedAt, "result.generatedAt"),
    reports,
    accountsWithoutUsage: Object.freeze(
      array(
        input.accountsWithoutUsage,
        "result.accountsWithoutUsage",
        MAX_ACCOUNTS_WITHOUT_USAGE,
      ).map((account, index) => accountFrom(account, `result.accountsWithoutUsage[${index}]`)),
    ),
    capacity: capacityFrom(input.capacity, "result.capacity"),
  });
}

/** Resolve utilization exactly as OMP does, including explicit overage. */
export function resolveUsedFraction(limit: UsageLimit): number | undefined {
  const amount = limit.amount;
  if (amount.usedFraction !== undefined) return amount.usedFraction;
  if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) {
    return amount.used / amount.limit;
  }
  if (amount.unit === "percent" && amount.used !== undefined) return amount.used / 100;
  if (amount.remainingFraction !== undefined) return Math.max(0, 1 - amount.remainingFraction);
  return undefined;
}

export function resolvedUsageStatus(limit: UsageLimit): UsageStatus {
  if (limit.status !== undefined && limit.status !== "unknown") return limit.status;
  const fraction = resolveUsedFraction(limit);
  if (fraction === undefined) return "unknown";
  if (fraction >= 1) return "exhausted";
  if (fraction >= 0.8) return "warning";
  return "ok";
}

export function usageProviderGroups(snapshot: UsageSnapshot): readonly UsageProviderGroup[] {
  const providers = new Set<string>();
  for (const report of snapshot.reports) providers.add(report.provider);
  for (const account of snapshot.accountsWithoutUsage) providers.add(account.provider);
  for (const provider of Object.keys(snapshot.capacity)) providers.add(provider);
  return Object.freeze(
    [...providers]
      .sort((left, right) => left.localeCompare(right))
      .map((provider) =>
        Object.freeze({
          provider,
          reports: Object.freeze(snapshot.reports.filter((report) => report.provider === provider)),
          accountsWithoutUsage: Object.freeze(
            snapshot.accountsWithoutUsage.filter((account) => account.provider === provider),
          ),
          capacity: snapshot.capacity[provider] ?? Object.freeze([]),
        }),
      ),
  );
}

export function providerDisplayName(provider: string): string {
  return provider
    .split(/[-_]/gu)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function reportAccountLabel(report: UsageReport, index: number): string {
  const identity = report.identity;
  const direct = identity.email ?? identity.accountId ?? identity.projectId;
  if (direct !== undefined) return direct;
  for (const limit of report.limits) {
    const scoped = limit.scope.accountId ?? limit.scope.projectId;
    if (scoped !== undefined) return scoped;
  }
  return `Account ${index + 1}`;
}

export function accountIdentityLabel(account: UsageAccountIdentity): string {
  if (account.type === "api_key") return "API key";
  return account.email ?? account.accountId ?? account.projectId ?? account.enterpriseUrl ?? "OAuth account";
}

export function reportStatus(report: UsageReport): UsageStatus {
  const statuses = report.limits.map(resolvedUsageStatus);
  if (statuses.includes("exhausted")) return "exhausted";
  if (statuses.includes("warning")) return "warning";
  if (statuses.includes("ok")) return "ok";
  return "unknown";
}
