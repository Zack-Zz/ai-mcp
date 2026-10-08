import type { InvocationContext, InvocationOutcome, InvocationFault } from '@ai-mcp/shared';
import type { Middleware, ServerContext } from './types.js';
import type { RegistrySnapshot } from './tool-registry.js';

function unknownToolFault(name: string, context: InvocationContext): InvocationFault {
  return {
    category: 'invalid_request',
    projectCode: 'INVALID_REQUEST',
    message: `Tool not found: ${name}`,
    traceId: context.traceId,
    invocationId: context.invocationId,
    executionDisposition: 'not_started',
    source: { kind: 'local' }
  };
}

/**
 * Single shared invocation pipeline for every protocol entry point
 * (native tools/call and legacy handleRawRequest). Middlewares wrap the
 * terminal, and the terminal is the only place that parses input, executes
 * the handler and validates output, so audits observe the real outcome.
 */
export class ToolDispatcher {
  private readonly middlewares: Middleware[];

  constructor(
    private readonly snapshot: RegistrySnapshot,
    middlewares: Middleware[] = []
  ) {
    // Shared by reference with the server facade so later use() calls apply.
    this.middlewares = middlewares;
  }

  public async invoke(
    name: string,
    args: unknown,
    context: InvocationContext
  ): Promise<InvocationOutcome> {
    const tool = this.snapshot.find(name);
    if (!tool) {
      return { kind: 'failure', fault: unknownToolFault(name, context) };
    }

    const ctx: ServerContext = {
      traceId: context.traceId,
      method: 'tools/call',
      toolName: name,
      invocationId: context.invocationId
    };

    const controller = new AbortController();
    const abort = () => controller.abort(context.signal.reason);
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    const abortIfExpired = () => {
      if (Date.now() >= context.deadlineAt)
        controller.abort(new DOMException('Tool call deadline exceeded', 'TimeoutError'));
    };
    abortIfExpired();
    const remaining = context.deadlineAt - Date.now();
    const timer =
      remaining > 0 && remaining < 2_147_483_647
        ? setTimeout(
            () => controller.abort(new DOMException('Tool call deadline exceeded', 'TimeoutError')),
            remaining
          )
        : undefined;
    let outcome: InvocationOutcome | undefined;
    let started = false;
    const observeOutcome = (value: InvocationOutcome) => {
      outcome = value;
      ctx.outcome =
        value.kind === 'success' ? 'ok' : value.kind === 'tool_failure' ? 'tool_error' : 'error';
      if (value.kind !== 'success') {
        ctx.faultCode = value.fault.projectCode;
      }
      ctx.outcomeDetail = value;
    };
    let onAbort!: () => void;
    const interrupted = new Promise<InvocationOutcome>((resolve) => {
      onAbort = () => {
        const timeout =
          controller.signal.reason instanceof Error &&
          controller.signal.reason.name === 'TimeoutError';
        const disposition = outcome
          ? outcome.kind === 'failure'
            ? outcome.fault.executionDisposition
            : 'completed'
          : started
            ? 'unknown'
            : 'not_started';
        const failure: InvocationOutcome = {
          kind: 'failure',
          fault: {
            category: timeout ? 'backend_timeout' : 'cancelled',
            projectCode: timeout ? 'TIMEOUT' : 'CANCELLED',
            message: timeout ? 'Tool call deadline exceeded' : 'Tool call cancelled',
            traceId: context.traceId,
            invocationId: context.invocationId,
            executionDisposition: disposition,
            source: { kind: 'local' }
          }
        };
        observeOutcome(failure);
        resolve(failure);
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    try {
      if (controller.signal.aborted) return await interrupted;
      const pipeline = (async (): Promise<InvocationOutcome> => {
        await this.runMiddlewares(
          ctx,
          async () => {
            abortIfExpired();
            if (controller.signal.aborted) return;
            observeOutcome(
              await tool.invoke(args, { ...context, signal: controller.signal }, () => {
                started = true;
              })
            );
          },
          controller.signal,
          abortIfExpired
        );
        abortIfExpired();
        if (controller.signal.aborted) return await interrupted;

        if (!outcome)
          return {
            kind: 'failure',
            fault: {
              category: 'internal',
              projectCode: 'INTERNAL',
              message: `Middleware pipeline did not execute tool: ${name}`,
              traceId: context.traceId,
              invocationId: context.invocationId,
              executionDisposition: 'not_started',
              source: { kind: 'local' }
            }
          };
        return outcome;
      })();
      return await Promise.race([pipeline, interrupted]);
    } finally {
      if (timer) clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  private async runMiddlewares(
    ctx: ServerContext,
    terminal: () => Promise<void>,
    signal: AbortSignal,
    abortIfExpired: () => void
  ): Promise<void> {
    let index = -1;
    const runner = async (position: number): Promise<void> => {
      abortIfExpired();
      if (signal.aborted) return;
      if (position <= index) {
        throw new Error('next() called multiple times');
      }
      index = position;
      const middleware = this.middlewares[position];
      if (!middleware) {
        await terminal();
        return;
      }
      const next = async (): Promise<void> => runner(position + 1);
      await middleware(ctx, next);
    };
    await runner(0);
  }
}
