export function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function display(value: unknown): string {
  if (value === undefined || value === null || value === "") return "-";
  return String(value);
}

export function renderTable(rows: readonly Record<string, unknown>[], columns: readonly [string, string][]): string {
  const widths = columns.map(([key, title]) => Math.max(title.length, ...rows.map((row) => display(row[key]).length)));
  const line = (values: readonly string[]): string => values.map((value, index) => value.padEnd(widths[index] ?? value.length)).join("  ").trimEnd();
  const body = rows.map((row) => line(columns.map(([key]) => display(row[key])))).join("\n");
  return `${line(columns.map(([, title]) => title))}\n${line(widths.map((width) => "-".repeat(width)))}\n${body}${body ? "\n" : ""}`;
}
