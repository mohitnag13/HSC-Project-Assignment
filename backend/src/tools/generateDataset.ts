/**
 * Synthetic legacy export with the same classes of problems as GlobalHealth's
 * sample (mixed date formats, currency symbols, unquoted thousands separators,
 * missing contact data, duplicates out of order), at volume. Used to exercise
 * batching, rate limiting, retries and 400 isolation. Deterministic per seed.
 */

export interface GenerateOptions {
  /** Unique patients to generate (rows = patients + duplicate versions). */
  patients: number;
  seed?: number;
  /** Share of patients that get one or two older versions. */
  duplicateRate?: number;
  /** Share of rows with a malformed email (accepted locally, rejected by the API with 400). */
  invalidEmailRate?: number;
  /** Share of rows that cannot be normalised (quarantined locally). */
  corruptRowRate?: number;
  /** Reference time for last_modified values. */
  now?: Date;
}

export interface GeneratedDataset {
  fileName: string;
  csv: string;
  rows: number;
  patients: number;
  seed: number;
}

export const MAX_GENERATED_PATIENTS = 50_000;

const FIRST_NAMES = [
  'Olivia', 'Liam', 'Emma', 'Noah', 'Ava', 'Elijah', 'Sophia', 'James', 'Isabella', 'Lucas',
  'Mia', 'Mason', 'Amelia', 'Ethan', 'Harper', 'Logan', 'Evelyn', 'Aiden', 'Abigail', 'Mateo',
  'Priya', 'Arjun', 'Chen', 'Wei', 'Fatima', 'Omar', 'Sofia', 'Diego', 'Hana', 'Kenji',
  'Zara', 'Malik', 'Ingrid', 'Lars', 'Aisha', 'Yusuf', 'Grace', 'Daniel', 'Chloe', 'Samuel',
];
const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez',
  'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin',
  'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson',
  'Walker', 'Young', 'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores',
];
const DOMAINS = ['email.com', 'mail.net', 'inbox.org', 'ghc-mail.com'];
const HEADER = 'patient_id,first_name,last_name,dob,email,phone,account_balance,last_modified';
const DAY_MS = 24 * 60 * 60 * 1000;

type Random = () => number;

/** mulberry32: tiny, fast, seedable PRNG. */
function createRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const pad = (value: number) => String(value).padStart(2, '0');

/** A CSV field; `raw` fields are emitted without quoting, even when they contain commas. */
interface Field {
  text: string;
  raw?: boolean;
}

function encodeField(field: Field): string {
  if (field.raw || !/[",\n]/.test(field.text)) return field.text;
  return `"${field.text.replace(/"/g, '""')}"`;
}

interface PatientVersion {
  id: string;
  first: string;
  last: string;
  dob: { year: number; month: number; day: number };
  email: string | null;
  phone: string | null;
  balance: number;
  euro: boolean;
  lastModified: Date;
}

function formatDob(random: Random, { year, month, day }: PatientVersion['dob']): string {
  const roll = random();
  if (roll < 0.4) return `${year}-${pad(month)}-${pad(day)}`;
  if (roll < 0.75) return `${pad(month)}/${pad(day)}/${year}`;
  return `${pad(day)}-${pad(month)}-${year}`;
}

function formatBalance(random: Random, balance: number, euro: boolean): Field {
  const magnitude = Math.abs(balance);
  const plain = magnitude.toFixed(2);
  const grouped = magnitude.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (euro) return { text: `€${balance < 0 ? '-' : ''}${plain}` };
  if (balance < 0) return { text: random() < 0.5 ? `$-${plain}` : `(${plain})` };
  const roll = random();
  if (roll < 0.3) return { text: `$${grouped}` };
  if (roll < 0.55) return { text: plain };
  if (roll < 0.85) return { text: `$${plain}` };
  if (roll < 0.96 || !grouped.includes(',')) return { text: grouped };
  // The export bug from the sample (P-1002): thousands separator left unquoted.
  return { text: grouped, raw: true };
}

function formatTimestamp(random: Random, date: Date): string {
  const iso = date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return random() < 0.03 ? iso.replace('T', ' ').replace('Z', '') : iso;
}

function corruptEmail(random: Random, first: string, last: string, domain: string): string {
  const local = `${first}.${last}`.toLowerCase();
  return pick(random, [`${local}@`, `${local}.${domain}`, `${first} ${last}@${domain}`.toLowerCase(), `${local}@@${domain}`]);
}

export function generateDataset(options: GenerateOptions): GeneratedDataset {
  const patients = Math.max(1, Math.min(MAX_GENERATED_PATIENTS, Math.floor(options.patients)));
  const seed = options.seed ?? 42;
  const duplicateRate = options.duplicateRate ?? 0.12;
  const invalidEmailRate = options.invalidEmailRate ?? 0.01;
  const corruptRowRate = options.corruptRowRate ?? 0.005;
  const now = options.now ?? new Date();
  const random = createRandom(seed);

  const versions: PatientVersion[] = [];
  for (let index = 0; index < patients; index += 1) {
    const first = pick(random, FIRST_NAMES);
    const last = pick(random, LAST_NAMES);
    const year = 1935 + Math.floor(random() * 78);
    const month = 1 + Math.floor(random() * 12);
    const day = 1 + Math.floor(random() * 28);
    const domain = pick(random, DOMAINS);
    const balanceRoll = random();
    const current: PatientVersion = {
      id: `P-${20001 + index}`,
      first,
      last,
      dob: { year, month, day },
      email: random() < 0.08 ? null : `${first}.${last}${Math.floor(random() * 90) + 10}@${domain}`.toLowerCase(),
      phone: random() < 0.06 ? null : `555-${String(Math.floor(random() * 10_000)).padStart(4, '0')}`,
      balance: balanceRoll < 0.1 ? 0 : balanceRoll < 0.15 ? -Math.round(random() * 50_000) / 100 : Math.round(random() * 1_200_000) / 100,
      euro: random() < 0.02,
      lastModified: new Date(now.getTime() - Math.floor(random() * 30 * DAY_MS) - DAY_MS),
    };
    versions.push(current);

    if (random() < duplicateRate) {
      const extra = random() < 0.7 ? 1 : 2;
      for (let n = 1; n <= extra; n += 1) {
        versions.push({
          ...current,
          email: random() < 0.5 ? `${first}.${last}@old-${domain}`.toLowerCase() : current.email,
          balance: random() < 0.6 ? Math.round(random() * 500_000) / 100 : current.balance,
          lastModified: new Date(current.lastModified.getTime() - n * (DAY_MS + Math.floor(random() * 20 * DAY_MS))),
        });
      }
    }
  }

  // Shuffle so older versions can precede newer ones, as in the sample (P-1003).
  for (let i = versions.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [versions[i], versions[j]] = [versions[j] as PatientVersion, versions[i] as PatientVersion];
  }

  const lines = [HEADER];
  for (const version of versions) {
    let id = version.id;
    if (random() < 0.02) id = random() < 0.5 ? ` ${id.toLowerCase()}` : `${id} `;
    let dob = formatDob(random, version.dob);
    let lastModified = formatTimestamp(random, version.lastModified);
    let email = version.email ?? '';
    if (email && random() < invalidEmailRate) email = corruptEmail(random, version.first, version.last, pick(random, DOMAINS));
    if (random() < corruptRowRate) {
      const corruption = Math.floor(random() * 3);
      if (corruption === 0) dob = 'N/A';
      else if (corruption === 1) dob = `${version.dob.year}-02-30`;
      else lastModified = 'unknown';
    }
    const fields: Field[] = [
      { text: id },
      { text: version.first },
      { text: version.last },
      { text: dob },
      { text: email },
      { text: version.phone ?? '' },
      formatBalance(random, version.balance, version.euro),
      { text: lastModified },
    ];
    lines.push(fields.map(encodeField).join(','));
  }

  return {
    fileName: `generated_${patients}_patients_seed${seed}.csv`,
    csv: `${lines.join('\n')}\n`,
    rows: versions.length,
    patients,
    seed,
  };
}
