export function readHost(options: { host: string; bin: string; scratch: string; origin: string; token: string; artifactFixture?: boolean }): Promise<{
  close(): Promise<void>;
  grantWrites(operations: string[]): Promise<void>;
  invokeClient(args: string[], code?: number, input?: string): Promise<unknown>;
  invoke(args: string[], code: number, input?: { stdin?: string; files?: { name: string; contentBase64: string }[] }): Promise<unknown>;
  api<T = unknown>(path: string, method?: string, body?: unknown, expectedStatus?: number): Promise<T>;
  download(args: string[]): Promise<string>;
  refuse(args: string[], code: string): Promise<unknown>;
}>;
