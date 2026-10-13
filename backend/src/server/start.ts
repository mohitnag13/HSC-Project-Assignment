import { isLoopbackHost, type ConsoleConfig } from '../config/env.js';
import { BACKEND_ROOT, REPO_ROOT, SAMPLE_CSV } from '../config/paths.js';
import { startMockApi, type MockApiHandle } from '../mock-api/start.js';
import { closeServer, listen, serverUrl } from '../shared/http.js';
import type { Logger } from '../shared/logger.js';
import { createConsoleApp } from './app.js';
import { RunManager } from './runManager.js';

export interface ConsoleHandle {
  url: string;
  mockApiUrl: string | null;
  close(): Promise<void>;
}

/** Starts the migration console API (and, by default, the mock SHC API next to it). */
export async function startConsole(config: ConsoleConfig, logger: Logger): Promise<ConsoleHandle> {
  let mockApi: MockApiHandle | null = null;
  if (config.startMockApi) {
    mockApi = await startMockApi({
      host: config.mockApi.host,
      port: config.mockApi.port,
      token: config.mockApi.token,
      settings: { failureRate: config.mockApi.failureRate, throttleRate: config.mockApi.throttleRate },
      logger,
    });
  }

  const loopback = isLoopbackHost(config.host);
  const runs = new RunManager({ outputDir: config.outputDir, logger });
  const app = createConsoleApp({
    runs,
    mock: mockApi ? { store: mockApi.store, apiUrl: mockApi.patientsUrl, token: config.mockApi.token } : null,
    defaultApiUrl: config.defaultApiUrl,
    paths: { sampleCsv: SAMPLE_CSV, repoRoot: REPO_ROOT, backendRoot: BACKEND_ROOT, staticDir: config.staticDir },
    security: { hostGuard: loopback, allowCustomTargets: config.allowCustomTargets },
    logger,
  });

  let server;
  try {
    server = await listen(app, config.port, config.host);
  } catch (error) {
    // Don't leave the mock API running behind a console that failed to start (e.g. EADDRINUSE).
    await mockApi?.close();
    throw error;
  }
  const url = serverUrl(server, config.host);
  logger.info(`Migration console API listening on ${url}/api`);
  if (!loopback) {
    logger.warn('The console is reachable from other machines and has no login; expose it only on a trusted network', {
      host: config.host,
      customTargets: config.allowCustomTargets,
    });
  }

  return {
    url,
    mockApiUrl: mockApi?.patientsUrl ?? null,
    close: async () => {
      runs.cancelAll();
      await closeServer(server);
      await mockApi?.close();
    },
  };
}
