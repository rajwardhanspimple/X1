export function isoWeekStart(input: Date | string): Date {
  const date = typeof input === 'string' ? new Date(input) : new Date(input.getTime());
  if (Number.isNaN(date.getTime())) throw new RangeError('Invalid date');
  const day = date.getUTCDay() || 7;
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date;
}

export function periodEnd(start: Date, days: number): Date {
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + days);
  end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
  return end;
}
