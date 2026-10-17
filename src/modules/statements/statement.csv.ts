// Statement CSV: plain, spreadsheet-friendly, and safe to open. Descriptions are user-written
// text, so a cell starting with = + - @ (or a tab or carriage return) is prefixed with a quote
// so spreadsheet apps show it as text instead of running it as a formula (CSV injection).
import { MINOR_UNITS, type Currency } from '../../common/constants/currency.ts';

const FORMULA_START = /^[=+\-@\t\r]/;
const LAGOS_OFFSET_MS = 60 * 60 * 1_000;

export function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** `150025n` → `1500.25`: major units with two decimals, no symbol or separators. */
export function decimal(amount: bigint, currency: Currency): string {
  const unit = MINOR_UNITS[currency];
  const sign = amount < 0n ? '-' : '';
  const abs = amount < 0n ? -amount : amount;
  const fraction = (abs % unit).toString().padStart(unit.toString().length - 1, '0');
  return `${sign}${(abs / unit).toString()}.${fraction}`;
}

/** Lagos wall-clock time, `2026-10-15 14:03:22`. */
export function lagosTimestamp(at: Date): string {
  return new Date(at.getTime() + LAGOS_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

export interface StatementLine {
  at: Date;
  reference: string;
  type: string;
  description: string | null;
  direction: 'DEBIT' | 'CREDIT';
  amount: bigint;
  balanceAfter: bigint;
}

export interface StatementContent {
  accountName: string;
  accountNumber: string;
  currency: Currency;
  periodStart: string;
  periodEnd: string;
  openingBalance: bigint;
  closingBalance: bigint;
  lines: readonly StatementLine[];
}

export function statementCsv(s: StatementContent): string {
  const row = (...cells: string[]) => cells.map(csvCell).join(',');
  const money = (amount: bigint) => decimal(amount, s.currency);
  return [
    row('Fundra account statement'),
    row('Account name', s.accountName),
    row('Account number', s.accountNumber),
    row('Currency', s.currency),
    row('Period', `${s.periodStart} to ${s.periodEnd} (Africa/Lagos)`),
    row('Opening balance', money(s.openingBalance)),
    row('Closing balance', money(s.closingBalance)),
    '',
    row('Date', 'Reference', 'Type', 'Description', 'Debit', 'Credit', 'Balance'),
    ...s.lines.map((line) =>
      row(
        lagosTimestamp(line.at),
        line.reference,
        line.type,
        line.description ?? '',
        line.direction === 'DEBIT' ? money(line.amount) : '',
        line.direction === 'CREDIT' ? money(line.amount) : '',
        money(line.balanceAfter),
      ),
    ),
    '',
  ].join('\r\n');
}
