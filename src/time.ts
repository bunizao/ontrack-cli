export class CivilDate {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static parse(value: string): CivilDate {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError(`Invalid civil date: ${value}`);
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
      throw new TypeError(`Invalid civil date: ${value}`);
    }
    return new CivilDate(value);
  }

  compare(other: CivilDate): -1 | 0 | 1 {
    return this.#value < other.#value ? -1 : this.#value > other.#value ? 1 : 0;
  }

  addDays(days: number): CivilDate {
    const [year, month, day] = this.#value.split("-").map(Number);
    const value = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day));
    value.setUTCDate(value.getUTCDate() + days);
    return CivilDate.parse(value.toISOString().slice(0, 10));
  }

  toString(): string {
    return this.#value;
  }
}

export class Instant {
  readonly #value: Date;

  private constructor(value: Date) {
    this.#value = value;
  }

  static parse(value: string): Instant {
    if (!value.includes("T")) throw new TypeError(`Invalid instant: ${value}`);
    const parsed = new Date(value);
    if (Number.isNaN(parsed.valueOf())) throw new TypeError(`Invalid instant: ${value}`);
    return new Instant(parsed);
  }

  compare(other: Instant): -1 | 0 | 1 {
    const left = this.#value.valueOf();
    const right = other.#value.valueOf();
    return left < right ? -1 : left > right ? 1 : 0;
  }

  toString(): string {
    return this.#value.toISOString();
  }
}

export interface Clock {
  readonly now: Instant;
  readonly today: CivilDate;
}

export function createClock(override?: string): Clock {
  if (override) {
    const match = /^(\d{4}-\d{2}-\d{2})T/.exec(override);
    if (!match?.[1]) throw new TypeError(`Invalid instant: ${override}`);
    return { now: Instant.parse(override), today: CivilDate.parse(match[1]) };
  }
  const value = new Date();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return {
    now: Instant.parse(value.toISOString()),
    today: CivilDate.parse(`${value.getFullYear()}-${month}-${day}`),
  };
}
