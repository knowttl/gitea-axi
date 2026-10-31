import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

// Process preload inherited by test children: fake services may use loopback only.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: Parameters<typeof connect>) {
  const first: unknown = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === 'object' && first !== null ? first as { host?: string; path?: string } : undefined;
  const host = options?.host ?? (typeof args[1] === 'string' ? args[1] : 'localhost');
  if (!options?.path && !['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('Offline test denied outbound connection');
  return Reflect.apply(connect, this, args);
} as typeof connect;
syncBuiltinESMExports();
