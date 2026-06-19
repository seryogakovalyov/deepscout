import type { toolDefinitions } from "./definitions";

export interface ToolExecutionContext {
  signal: AbortSignal;
  status(text: string): void;
}

export type ToolName = keyof typeof toolDefinitions;

export type ToolParams = {
  [K in ToolName]: {
    [P in keyof (typeof toolDefinitions)[K]["parameters"]]:
      (typeof toolDefinitions)[K]["parameters"][P] extends { parse(input: unknown): infer R } ? R : never;
  };
};

export type ToolHandler<K extends ToolName> = (
  params: ToolParams[K],
  ctx: ToolExecutionContext,
) => Promise<string>;

export type ToolHandlers = {
  [K in ToolName]: ToolHandler<K>;
};
