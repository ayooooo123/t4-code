import {
  resolveUsedFraction,
  type ProviderWindowStat,
  type UsageLimit,
  type UsageReport,
  type UsageUnit,
} from "./model.ts";

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const COMPACT_NUMBER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

function plural(value: number, singular: string, pluralForm = `${singular}s`): string {
  return `${NUMBER.format(value)} ${value === 1 ? singular : pluralForm}`;
}

export function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  if (seconds < 60) return seconds < 5 ? "a few seconds" : plural(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return plural(hours, "hour");
  const days = Math.round(hours / 24);
  return plural(days, "day");
}

export function ageLabel(timestamp: number, nowMs: number): string {
  const delta = nowMs - timestamp;
  if (delta < -5_000) return `in ${formatDuration(-delta)}`;
  if (delta < 5_000) return "just now";
  return `${formatDuration(delta)} ago`;
}

function amountValue(value: number, unit: UsageUnit): string {
  if (unit === "usd") return USD.format(value);
  if (unit === "bytes") {
    if (value >= 1_073_741_824) return `${NUMBER.format(value / 1_073_741_824)} GiB`;
    if (value >= 1_048_576) return `${NUMBER.format(value / 1_048_576)} MiB`;
    if (value >= 1_024) return `${NUMBER.format(value / 1_024)} KiB`;
    return `${NUMBER.format(value)} B`;
  }
  return COMPACT_NUMBER.format(value);
}

function unitLabel(unit: UsageUnit): string {
  if (unit === "tokens") return " tokens";
  if (unit === "requests") return " requests";
  if (unit === "minutes") return " min";
  return "";
}

export function usageAmountLabel(limit: UsageLimit): string {
  const { amount } = limit;
  const parts: string[] = [];
  const absolute = amount.unit !== "percent" && amount.unit !== "unknown";
  if (absolute && amount.used !== undefined && amount.limit !== undefined) {
    parts.push(
      `${amountValue(amount.used, amount.unit)} of ${amountValue(amount.limit, amount.unit)}${unitLabel(amount.unit)}`,
    );
  } else if (absolute && amount.remaining !== undefined) {
    parts.push(`${amountValue(amount.remaining, amount.unit)}${unitLabel(amount.unit)} left`);
  }
  const fraction = resolveUsedFraction(limit);
  if (fraction !== undefined) parts.push(`${(fraction * 100).toFixed(fraction < 0.01 ? 2 : 1)}% used`);
  else if (amount.remainingFraction !== undefined) {
    parts.push(`${(amount.remainingFraction * 100).toFixed(1)}% left`);
  }
  return parts.length === 0 ? "No amount reported" : parts.join(" · ");
}

export function limitDisplayName(limit: UsageLimit): string {
  let label = limit.label;
  const tier = limit.scope.tier;
  if (tier !== undefined && !label.toLowerCase().includes(tier.toLowerCase())) {
    label = `${label} (${tier})`;
  }
  const windowLabel = limit.window?.label ?? limit.scope.windowId;
  if (
    windowLabel === undefined ||
    windowLabel.toLowerCase() === "quota window" ||
    label.toLowerCase().includes(windowLabel.toLowerCase())
  ) {
    return label;
  }
  return `${label} (${windowLabel})`;
}

export function resetLabel(limit: UsageLimit, nowMs: number): string | null {
  const reset = limit.window?.resetsAt;
  if (reset === undefined) return null;
  if (reset <= nowMs) return "Reset time has passed";
  return `Resets in ${formatDuration(reset - nowMs)}`;
}

export function capacityLabel(stat: ProviderWindowStat): string {
  const accounts = plural(stat.accounts, "account");
  return `${NUMBER.format(stat.remainingAccounts)} of ${accounts} left`;
}

export function reportIdentityDetail(report: UsageReport, accountLabel: string): string | null {
  const parts: string[] = [];
  const organization = report.identity.orgName ?? report.identity.orgId;
  if (organization !== undefined && organization !== accountLabel) parts.push(organization);
  if (report.identity.planType !== undefined) parts.push(`${report.identity.planType} plan`);
  return parts.length === 0 ? null : parts.join(" · ");
}

export function savedResetLabel(report: UsageReport, nowMs: number): string | null {
  const count = report.resetCredits?.availableCount ?? 0;
  if (count <= 0) return null;
  const expiries = (report.resetCredits?.credits ?? [])
    .map((credit) => (credit.expiresAt === undefined ? Number.NaN : Date.parse(credit.expiresAt)))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  const upcoming = expiries.find((value) => value > nowMs);
  const base = `${plural(count, "saved reset")}`;
  return upcoming === undefined ? base : `${base} · next expires in ${formatDuration(upcoming - nowMs)}`;
}
