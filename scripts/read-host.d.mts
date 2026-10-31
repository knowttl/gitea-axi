export function readHost(options: { host: string; bin: string; scratch: string; origin: string; token: string }): Promise<{
  close(): Promise<void>;
  grantWrites(operations: string[]): Promise<void>;
  invokeClient(args: string[], code?: number): Promise<unknown>;
  invoke(args: string[], code: number): Promise<unknown>;
  refuse(args: string[], code: string): Promise<unknown>;
}>;
