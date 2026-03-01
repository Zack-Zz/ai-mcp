export type BackendTool = {
  name: string;
  description: string;
};

export type DownstreamConnector = {
  listTools(): Promise<BackendTool[]>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
};
