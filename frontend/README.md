# SHC Migration Console (frontend)

React 19 + Vite UI for the GlobalHealth Corp → SHC Platform ingestion pipeline. It talks to the console API in `../backend` (proxied at `/api` during development) and covers every task of the brief:

| Page | Task |
|---|---|
| Extract & normalise | 1: load the sample, upload a CSV or generate a messy dataset; see every anomaly, repair and duplicate decision |
| Load to SHC API | 2: configure batching, rate limit and backoff; watch the load live (requests per second, retries, bisections, failed records) |
| SHC Platform data | Verification: what the mock SHC API stored, and the request rate it measured |
| Containerization | 3: build and run commands, environment variables, Dockerfile and compose file |
| Client email / README | 4 and documentation, rendered from the repository's Markdown |

```bash
npm install
npm run dev     # http://localhost:5173 (start the backend too; see ../README.md)
npm run lint
npm run build   # dist/, served by the backend in production (npm start in ../backend)
```
