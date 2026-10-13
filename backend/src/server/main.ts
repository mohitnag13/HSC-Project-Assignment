import { ConfigError, loadConsoleConfig } from '../config/env.js';
import { REPO_ROOT } from '../config/paths.js';
import { createLogger } from '../shared/logger.js';
import { startConsole } from './start.js';

try {
  const config = loadConsoleConfig(process.env, { repoRoot: REPO_ROOT });
  const logger = createLogger({ level: config.logLevel, format: config.logFormat });
  const handle = await startConsole(config, logger);

  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down`);
    void handle.close().then(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
}
