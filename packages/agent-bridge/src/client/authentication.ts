import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BridgeError } from '../contracts/errors.js';
import type { OperationReply } from '../contracts/types.js';
import type { RpcRequest } from './protocol.js';

type RequestBody = Omit<RpcRequest, 'proof'>;
type ControlProof = { bindingHash: string; challenge: string; proof: string };

function mac(purpose: 'request' | 'response', token: string, value: unknown): string {
  return createHmac('sha256', token)
    .update(`agent-bridge/ipc-v1/${purpose}\0`)
    .update(JSON.stringify(value))
    .digest('hex');
}

function matches(given: unknown, expected: string): boolean {
  return (
    typeof given === 'string' &&
    /^[a-f0-9]{64}$/.test(given) &&
    timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'))
  );
}

export function signRequest(
  body: Omit<RequestBody, 'challenge' | 'issuedAtMs'>,
  token: string
): RpcRequest {
  const complete = { ...body, challenge: randomBytes(32).toString('hex'), issuedAtMs: Date.now() };
  return { ...complete, proof: mac('request', token, complete) };
}

export function verifyRequest(request: RpcRequest, token: string): void {
  const { proof, ...body } = request;
  if (!matches(proof, mac('request', token, body)))
    throw new BridgeError('AUTH_REQUIRED', 'Invalid control authentication');
}

export function signReply(
  reply: OperationReply,
  request: RpcRequest,
  token: string,
  bindingHash: string
): OperationReply & { controlProof: ControlProof } {
  const response = {
    requestProof: request.proof,
    bindingHash,
    challenge: request.challenge,
    reply
  };
  return {
    ...reply,
    controlProof: {
      bindingHash,
      challenge: request.challenge,
      proof: mac('response', token, response)
    }
  };
}

export function verifyReply(value: unknown, request: RpcRequest, token: string): OperationReply {
  const failure = () =>
    new BridgeError(
      'PROTOCOL_ERROR',
      'Unauthenticated control response; recover using the original requestId',
      'unknown'
    );
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure();
  const { controlProof, ...reply } = value as Record<string, unknown>;
  if (!controlProof || typeof controlProof !== 'object' || Array.isArray(controlProof))
    throw failure();
  const authentication = controlProof as Record<string, unknown>;
  if (
    Object.keys(authentication).length !== 3 ||
    typeof authentication.bindingHash !== 'string' ||
    authentication.challenge !== request.challenge
  )
    throw failure();
  const response = {
    requestProof: request.proof,
    bindingHash: authentication.bindingHash,
    challenge: request.challenge,
    reply
  };
  if (!matches(authentication.proof, mac('response', token, response))) throw failure();
  if (authentication.bindingHash !== request.bindingHash)
    throw new BridgeError(
      'RUNTIME_UNAVAILABLE',
      'Runtime binding changed; reconnect before issuing another operation',
      'unknown'
    );
  return reply as OperationReply;
}

/** Consume authenticated challenges before dispatch; never evict a still-valid nonce. */
export class ReplayWindow {
  private readonly consumed = new Map<string, number>();
  private lastTimeMs = Date.now();
  public constructor(private readonly capacity = 16384) {}
  public consume(request: RpcRequest, clockMs = Date.now()): void {
    const now = Math.max(clockMs, this.lastTimeMs);
    this.lastTimeMs = now;
    if (request.issuedAtMs < now - 30000 || request.issuedAtMs > now + 5000)
      throw new BridgeError(
        'REPLAY_REJECTED',
        'Control authentication has expired; recover using the original requestId',
        'unknown'
      );
    for (const [key, expires] of this.consumed) if (expires < now) this.consumed.delete(key);
    const key = JSON.stringify([request.callerRef, request.bindingHash, request.challenge]);
    if (this.consumed.has(key))
      throw new BridgeError(
        'REPLAY_REJECTED',
        'Replayed control authentication; recover using the original requestId',
        'unknown'
      );
    if (this.consumed.size >= this.capacity)
      throw new BridgeError(
        'RATE_LIMITED',
        'Control authentication window is full; wait before reconnecting'
      );
    this.consumed.set(key, request.issuedAtMs + 30000);
  }
}
