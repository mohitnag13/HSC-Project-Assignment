# Client communication

**To:** IT Director, GlobalHealth Corp

**From:** Forward Deployed Engineer, SHC Technologies

**Subject:** Patient data migration: ingestion container ready for your environment

---

Hello,

The pipeline that loads your legacy patient export into the SHC Platform is ready to run inside your own infrastructure. It ships as a single container image; patient data leaves your network only through authenticated calls to the SHC API.

**Building and running the container**

1. Build the image from the repository we shared:

   ```bash
   docker build -t shc-ingest:1.0.0 ./backend
   ```

2. Run it with the export mounted read-only and a folder for the results:

   ```bash
   docker run --rm \
     -e SHC_API_URL=https://api.mock-shc.com/v1/patients \
     -e SHC_API_TOKEN=<token issued by SHC> \
     -v /path/to/export:/data/input:ro \
     -v /path/to/results:/data/output \
     shc-ingest:1.0.0
   ```

   The container reads `/data/input/patients.csv`, runs as a non-root user and works with a read-only root filesystem. If your secrets live in a vault, mount the token as a file and set `SHC_API_TOKEN_FILE` instead of passing it as a variable.

3. Review the results folder: `run_report.json` summarises the run and `failed_records.json` lists any records the platform refused, with the reason. Exit code 0 means every record loaded; 2 means some records need attention.

For a rehearsal that sends nothing, add `-e DRY_RUN=true`: the file is cleaned and the result written out for your review.

**What we found in the sample export**

The nine sample rows resolve to seven patients:

- **Dates of birth in three formats** (YYYY-MM-DD, MM/DD/YYYY, DD-MM-YYYY). All are converted to ISO 8601; impossible dates are set aside for review, never guessed.
- **Duplicate patients.** P-1001 and P-1003 each appear twice. We keep the version with the latest `last_modified`, even when it appears earlier in the file.
- **Missing contact details.** Two patients have no email and two have no phone number. They are loaded with those fields empty rather than dropped.
- **Formatted amounts.** Balances carry `$`, `€` and thousands separators, and in P-1002's row an unquoted "1,250.00" shifted the columns. Amounts are parsed as plain numbers, and a shifted row is realigned only when exactly one reading is valid.

Two points need your confirmation:

- P-1003's latest balance is €300.00 (an older version says $300.00). We loaded 300.00 without currency conversion.
- P-1005's date of birth, 07/04/1988, was read as 4 July 1988 under your US-style slash format, but could also mean 7 April.

**One recommended change to the export**

Please have the export write dates in ISO 8601 (YYYY-MM-DD). Every other issue above can be detected and corrected automatically. A date such as 07/04/1988, however, is valid either way, so no downstream logic can tell which day was meant. Fixing this at the source removes the one class of error that could silently load a wrong date of birth.

I am happy to walk your team through a dry run whenever convenient.

Best regards,

[Your name]\
Forward Deployed Engineer, SHC Technologies
