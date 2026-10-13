import type { Server } from 'node:http';
import type { Express } from 'express';

/** Starts listening and resolves once the port is bound (rejects on EADDRINUSE etc.). */
export function listen(app: Express, port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

/** Closes a server, including idle keep-alive and streaming (SSE) connections. */
export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** Base URL of a bound server; wildcard hosts are mapped to loopback so the URL is callable. */
export function serverUrl(server: Server, host: string): string {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const reachableHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${reachableHost.includes(':') ? `[${reachableHost}]` : reachableHost}:${port}`;
}
