# GlobalHealth Corp → SHC Platform: legacy patient data ingestion

An ETL pipeline that extracts GlobalHealth's legacy patient CSV, cleans it, and loads it into the SHC REST API. It is packaged as a hardened container for their on-premise environment. A React migration console exercises every part of it from the browser.

| Brief | Where |
|---|---|
| Task 1: extraction and normalisation | `backend/src/etl/` |
| Task 2: API integration and fault tolerance | `backend/src/ingest/`, plus a mock SHC API in `backend/src/mock-api/` |
| Task 3: containerisation | `backend/Dockerfile`, `docker-compose.yml`, `backend/.env.example` |
| Task 4: client communication | `client_communication.md` |
| Everything in a UI | `frontend/` (React 19 + Vite) over the console API in `backend/src/server/` |

## Repository layout

```
hsc/
├── backend/                    TypeScript on Node 24
│   ├── src/
│   │   ├── etl/                CSV reader, row repair, normalisers, dedupe, transform (pure, no I/O)
│   │   ├── ingest/             batching, rate limiter, backoff, HTTP client, failed_records.json, pipeline
│   │   ├── mock-api/           mock SHC Platform API: auth, limits, validation, fault injection
│   │   ├── server/             console API for the UI (REST + server-sent events)
│   │   ├── config/             environment variables: one spec drives loaders, --help, UI and docs
│   │   ├── tools/              seeded generator for large messy test exports
│   │   └── cli.ts              container entrypoint: ingest | transform | generate | mock-api | serve
│   ├── test/                   Vitest suites
│   ├── data/patients.csv       the sample export from the brief, saved verbatim
│   ├── Dockerfile
│   └── .env.example
├── frontend/                   migration console
├── scripts/dev.mjs             starts backend + frontend together
├── docker-compose.yml          ingestion container + mock SHC API, end to end
├── client_communication.md
└── README.md
```

## Running it

Requires Node 22+ (developed on Node 24) and, for the container, Docker.

```bash
cd hsc
npm run setup      # install backend + frontend
npm run dev        # UI http://localhost:5173 · console API :4000 · mock SHC API :4010
```

New to the tool, or handing it to someone non-technical? Start with the illustrated step-by-step guide in `docs/SHC_Migration_Console_User_Guide.docx`.

The console opens on the sample export. Each sidebar page maps to a task: normalise (Task 1), load with live progress (Task 2), inspect what reached the mock platform, then the container (Task 3), the client email (Task 4) and this README.

**The ingestion script on its own** (from `backend/`):

```bash
npm run transform                 # dry run: writes output/normalized_records.json + run_report.json
npm run mock-api                  # terminal 1: mock SHC API on :4010, token "local-dev-token"
SHC_API_URL=http://127.0.0.1:4010/v1/patients SHC_API_TOKEN=local-dev-token npm run ingest   # terminal 2
npm run generate -- --patients 5000 --seed 7 --out data/large.csv   # messy data at volume
```

PowerShell: `$env:SHC_API_URL="http://127.0.0.1:4010/v1/patients"; $env:SHC_API_TOKEN="local-dev-token"; npm run ingest`.

**As a container:**

```bash
docker build -t shc-ingest:1.0.0 ./backend
mkdir -p output
docker compose up --build --abort-on-container-exit --exit-code-from ingest   # against the mock, with injected faults
```

**Production-style single process:** `npm run build && npm start` serves the built UI and the console API on :4000.

## Architecture decisions

**One core, three entry points.** The transform (`etl/transform.ts`) is a pure, synchronous function from CSV text to records plus a full anomaly report. The loader (`ingest/pipeline.ts`) takes records and reports progress as typed events. The CLI and container, the console API and the tests all call the same two functions, so what the UI shows is exactly what the container does.

**Stages.**

```
CSV text ─► tokenise (RFC 4180, relaxed) ─► align/repair rows ─► normalise fields ─► dedupe by patient_id
        ─► batch (≤100) ─► rate limiter (≤5 req/s) ─► POST ─► classify ─► retry · isolate 400s · log · abort
```

**Never guess silently.** Every value is repaired with a recorded reason, passed through with a warning, or quarantined:

| Situation | Decision |
|---|---|
| Unquoted thousands separator splits a row (P-1002: `…,,,1,250.00,…`) | Try merging the extra fields into each comma-tolerant column; accept only if **exactly one** distinct reading parses fully (email/phone shape only breaks ties). Otherwise quarantine. |
| A line with broken quoting (`"Smith"Jr`) | Re-read the file line by line and quarantine only that line; the rest loads. |
| Header variants | Exact names win over alternatives (`patient_id` over `id`, `last_modified` over `updated_at`); two columns competing for one field is rejected, not resolved silently. Trailing delimiters are ignored. |
| Missing email / phone | Load as `null` and flag (optional fields; not a reason to drop a patient). |
| Malformed email | Pass through (only lower-cased) with a warning. The SHC API is the authority; contact data is never guessed at. |
| Unparseable or impossible date, amount or timestamp | Quarantine the row (`run_report.json` lists it by line number and code). |
| Newest version of a patient is invalid | Withhold the patient rather than load an older, stale version. |

**Duplicates.** Rows are grouped by a normalised `patient_id` (trimmed, upper-cased). The version with the greatest `last_modified` wins, regardless of file order: P-1003's winner is on line 4, before its older version on line 9. Ties go to the later row. Timestamps without a zone are read as UTC and flagged, rather than taking the host's local zone.

**Amounts.** Symbols and ISO codes are stripped, and `-15`, `$-15.00`, `-$15.00` and `(15.00)` all mean −15. Commas and spaces are accepted only as correctly grouped thousands separators (`2,450.75`, `1 250.00`): `300,00` and `300 00` are refused, not read as 30000, and so are conflicting markers such as `(-15.00)` or `€100 USD`. Non-USD markers (P-1003's `€300.00`) are loaded at face value and flagged for the client; the payload schema has no currency field.

**Load path: how each response is handled.**

| Response | Handling |
|---|---|
| 2xx | done |
| 408, 429, 5xx, network error, timeout | retry with exponential backoff (equal jitter: delay in [d/2, d], d = min(cap, base·2ⁿ⁻¹)); `Retry-After` is a floor, honoured up to max(`BACKOFF_MAX_MS`, 60 s) |
| 400, 422 | if the response names the invalid records (`errors[].index`), log exactly those to `failed_records.json` and re-send the rest once; otherwise split the batch in half recursively until only the offending records fail. Continue either way |
| 3xx, 401, 403, 404, or a request that cannot be built | abort the run: every request would fail the same way (wrong URL, bad token). Redirects are never followed: `fetch` would turn the POST into a GET, and a 200 for that GET would look like a successful load |
| other 4xx | log the batch to `failed_records.json`, continue |

After `MAX_RETRIES`, a batch's records go to `failed_records.json` as `retries_exhausted` and the pipeline moves on. If three batches in a row exhaust their retries, the API is treated as down and the run stops (circuit breaker), instead of spending minutes per batch on a dead endpoint. Both 400 strategies assume a 400 rejects the whole batch atomically, which is how the mock behaves. With per-record details, one bad record in a batch of 100 costs one extra request; bisection, the fallback for APIs that don't say, costs about 14.

**Rate limiting.** Starts are spaced `ceil((1000 + margin) / N)` ms apart (210 ms for 5 req/s with a 50 ms jitter margin), measured from the moment each permit was actually granted. Five consecutive gaps always exceed one second, so no window can hold more than five request starts, whether the server counts by sliding window, fixed window or token bucket. Retries and bisection requests share the same limiter. Under load with injected faults, the mock API measured a peak of exactly 5 requests per second.

**Safety of retries and reruns.** Every request carries an `Idempotency-Key` (SHA-256 of the payload). The mock upserts by `patient_id` and ignores versions older than the stored one, so rerunning a file, or retrying after a lost response, cannot duplicate patients or roll them back.

**Observability and PHI.** Logs are JSON lines on stdout. They contain counts, batch IDs, patient IDs and anomaly codes, never names, dates or contact data, and never the token. `run_report.json` refers to quarantined rows by line number, anomaly code and field name only. `failed_records.json` necessarily contains the refused records, for re-drive.

**`failed_records.json` durability.** The CLI writes an empty file before sending anything, so an unwritable output folder fails the run up front rather than after the load. During the run, each failure is appended to `failed_records.json.partial.ndjson` (linear cost, nothing lost if the process is killed); the final JSON is written once, atomically, at the end. A previous file, or an interrupted run's journal, is archived rather than overwritten.

**Console security.** The console API is a local tool with no login, so it defends itself: it binds to 127.0.0.1 by default, answers only requests addressed to `localhost` (which blocks DNS rebinding from a malicious web page), and lets runs target arbitrary URLs only while `ALLOW_CUSTOM_TARGETS` is on (the default only on loopback). The container image sets no `HOST`, so nothing it runs is network-exposed unless asked for.

**Container.**
- **Build:** four stages. Dependencies, then the compile, then production-only dependencies, then the runtime, so the runtime has no compiler or test tooling.
- **User and files:** runs as uid 1000 (`node`). Application files are root-owned, and `/data/output` is the only writable path.
- **Signals:** `tini` runs as PID 1, so `SIGTERM` lets in-flight requests finish.
- **Secrets:** taken from the environment or from `SHC_API_TOKEN_FILE`, never baked into the image.
- **Hardened runtime:** works with `--read-only --cap-drop ALL --security-opt no-new-privileges`.
- **Exit codes:** 0 all loaded · 1 fatal or aborted · 2 finished with failed records · 130 cancelled.

**Dependencies.** Runtime dependencies are only `express` (mock and console API) and `csv-parse`. HTTP uses Node's built-in `fetch`. Configuration is validated at start-up, and every problem is reported at once.

**The mock SHC API.** `api.mock-shc.com` is not a real host, so `mock-api/` implements the contract from the brief:
- **Auth:** Bearer authentication, 401 otherwise.
- **Batch size:** at most 100 records per request, 413 otherwise.
- **Rate limit:** at most 5 requests per second, 429 with `Retry-After` otherwise.
- **Validation:** a 400 with per-record details if any record is invalid.
- **Fault injection** (adjustable live from the UI): random 5xx errors, throttling and latency.

## Date parsing logic

`etl/normalizers/date.ts`. The separator, not the digits, decides how a date is read. That is the only signal that stays reliable when day and month are both ≤ 12.

| Pattern | Read as | Example from the sample |
|---|---|---|
| `YYYY-MM-DD`, `YYYY/MM/DD` (optionally with a time) | year, month, day | `1980-05-15` → `1980-05-15` |
| `MM/DD/YYYY` (slash, year last) | US: month first, per the brief | `12/31/1992` → `1992-12-31` |
| `DD-MM-YYYY`, `DD.MM.YYYY` (dash or dot, year last) | day first, per the brief | `25-04-1975` → `1975-04-25` |
| `15 Aug 1999`, `Aug 15, 1999` | month by name | |

1. **Validate the calendar.** Months 1–12, days within the month, Gregorian leap years (`02/29/2000` is valid, `02/29/1900` is not). JavaScript's `Date` would silently roll `1990-02-30` over to March; this parser rejects it.
2. **Infer only when forced.** If a value is impossible under its convention but valid with day and month swapped (`25/04/1975`), it is accepted and flagged `DOB_INFERRED`.
3. **Flag ambiguity.** When both parts are ≤ 12 and differ (`07/04/1988`), the convention decides and the row is flagged `DOB_AMBIGUOUS` for client confirmation.
4. **Refuse to guess.** Two-digit years (century unknown), dates of birth in the future, and unrecognised formats are quarantined. A date of birth before 1900 is flagged but kept.
5. **Cross-check.** When a patient appears more than once, differing dates of birth across versions raise `DUPLICATE_CONFLICT`. In the sample, P-1003 is exported once as `25-04-1975` and once as `04/25/1975`. Both resolve to `1975-04-25`, which supports the separator-based reading.

The residual risk is the ambiguous case, which no downstream logic can resolve. The client email therefore recommends ISO 8601 at the source.

## The sample export, line by line

| Line | Patient | Outcome |
|---|---|---|
| 2 | P-1001 | superseded by line 5 (older `last_modified`) |
| 3 | P-1002 | loaded: 9 fields re-joined into `account_balance = 1250`; dob `12/31/1992` → `1992-12-31`; email and phone `null` |
| 4 | P-1003 | loaded: dob `25-04-1975` → `1975-04-25`; `€300.00` → `300` (flagged non-USD) |
| 5 | P-1001 | loaded: newest version (email `john.doe@newemail.com`, balance `0`) |
| 6 | P-1004 | loaded: `"2,450.75"` → `2450.75` |
| 7 | P-1005 | loaded: dob `07/04/1988` → `1988-07-04` (flagged ambiguous); email `null` |
| 8 | P-1006 | loaded: phone `null`; `$45.50` → `45.5` |
| 9 | P-1003 | superseded by line 4, even though it appears later in the file |
| 10 | P-1007 | loaded: dob `15-08-1999` → `1999-08-15`; `$-15.00` → `-15` |

Result: 9 rows → 7 patients, 1 row repaired, 0 quarantined.

## Tests

```bash
cd backend
npm test            # Vitest: 132 tests across 7 suites, ~8 s
npm run typecheck   # strict TypeScript, including the tests
```

| Suite | Covers |
|---|---|
| `normalizers.test.ts` | every date format, ambiguity, inference, leap years, future and two-digit years, strict month names; amounts (symbols, codes, negatives, spaced and comma grouping, conflicting markers); timestamps and zones; the email check's correctness and linear speed on hostile input |
| `transform.test.ts` | the exact clean output of the brief's sample; tie-breaks; withholding stale data; BOM, CRLF, reordered and variant column names; competing columns; trailing delimiters; a line with broken quoting; quarantine; row repair (ambiguous merges refused, contact fields as tie-breakers); per-row anomaly counts; no patient data in `run_report.json` |
| `rateLimitAndBackoff.test.ts` | limiter property (never more than N per second, deterministic fake clock); backoff growth, cap, `Retry-After` and its ceiling; status classification including redirects; batching |
| `pipeline.test.ts` | against the real mock over HTTP: batches of at most 100; at most 5 req/s as measured by the server; recovery from 429/5xx/network errors; retries exhausted and the circuit breaker; 400s isolated from per-record errors, and by bisection when the API gives none; redirects and unbuildable requests abort; 401 abort; cancellation; the `failed_records.json` journal |
| `mockApi.test.ts` | the mock's contract: auth, 413, 429 + `Retry-After`, validation details, stale-safe upserts |
| `consoleApi.test.ts` | the console API: a full load through it, the localhost-only Host check, custom targets off unless enabled, credential-bearing URLs refused, 4xx statuses preserved, the empty-token 401 demo |
| `config.test.ts` | environment parsing, token file, credentials in URLs and non-ASCII tokens refused, all-errors-at-once reporting |

Frontend: `cd frontend && npm run lint && npm run build`.

## Configuration

Every setting is an environment variable. The full table, with defaults, is in `backend/.env.example`, in `docker run … shc-ingest:1.0.0 help`, and on the console's Containerization page. The main ones:

| Variable | Default | |
|---|---|---|
| `SHC_API_URL` | `https://api.mock-shc.com/v1/patients` | endpoint |
| `SHC_API_TOKEN` / `SHC_API_TOKEN_FILE` | (required) | Bearer token, or a file containing it |
| `INPUT_FILE`, `OUTPUT_DIR` | `/data/input/patients.csv`, `/data/output` (in the container) | paths |
| `BATCH_SIZE` | `100` | 1–100 |
| `MAX_REQUESTS_PER_SECOND` | `5` | client-side limit |
| `MAX_RETRIES`, `BACKOFF_BASE_MS`, `BACKOFF_MAX_MS` | `5`, `500`, `30000` | backoff |
| `BISECT_ON_400` | `true` | isolate bad records when a 400 doesn't name them |
| `DRY_RUN` | `false` | normalise only |

## Assumptions to confirm with the SHC API team

- **Envelope.** The request body is `{ "patients": [ … ] }` (isolated in `buildPayload()`).
- **400 responses.** A 400 rejects the whole batch, and may name the invalid records as `errors[].index` (positions in the request), which is what the mock does. Anything else falls back to bisection, so the pipeline works either way; only its request count differs.
- **Upserts.** `POST /v1/patients` upserts by `patient_id`, so reruns are safe.
- **Dates and balances.** Slash dates are US (MM/DD) and dash dates are day-first, as the brief states. Negative balances are credits and are preserved.

## Next steps for production

- **Streaming.** Stream-parse with checkpointing, so multi-gigabyte exports resume after interruption without holding the file in memory.
- **Base image.** Pin it by digest, publish an SBOM, and sign the image.
- **Monitoring.** Export Prometheus metrics (records/s, retry rate, failure rate) and alert on `failed_records.json` growth.
