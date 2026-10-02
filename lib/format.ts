const INR = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

const INR_WITH_DECIMALS = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
});

export function formatINR(amount: number, withDecimals = false): string {
  return withDecimals ? INR_WITH_DECIMALS.format(amount) : INR.format(amount);
}

export function formatDate(d: Date | number): string {
  const date = typeof d === "number" ? new Date(d) : d;
  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });
}

export function formatDateTime(d: Date | number): string {
  const date = typeof d === "number" ? new Date(d) : d;
  return date.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function formatMonthYear(d: Date = new Date()): string {
  return d.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}
