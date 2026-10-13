import { closeServer, listen, serverUrl } from '../shared/http.js';
import type { Logger } from '../shared/logger.js';
import { createMockShcApp } from './app.js';
import { MockShcStore, type MockApiSettings } from './store.js';

export interface MockApiHandle {
  baseUrl: string;
  patientsUrl: string;
  store: MockShcStore;
  close(): Promise<void>;
}

export async function startMockApi(options: {
  host: string;
  port: number;
  token: string;
  settings?: Partial<MockApiSettings>;
  logger: Logger;
}): Promise<MockApiHandle> {
  const store = new MockShcStore({ tokens: [options.token], ...(options.settings ? { settings: options.settings } : {}) });
  const server = await listen(createMockShcApp(store), options.port, options.host);
  const baseUrl = serverUrl(server, options.host);
  options.logger.info(`Mock SHC API listening on ${baseUrl}/v1/patients`);
  return {
    baseUrl,
    patientsUrl: `${baseUrl}/v1/patients`,
    store,
    close: () => closeServer(server),
  };
}
