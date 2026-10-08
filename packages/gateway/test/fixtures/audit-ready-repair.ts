import { JsonlAuditStore } from '../../src/audit-jsonl.js';

const store = new JsonlAuditStore(process.argv[2] ?? '');
// Defer use until initialization has already had a chance to reject. That
// rejection must remain observable by record/close without killing Node.
setTimeout(() => {
  void (async () => {
    let recordFailed = false;
    let closeFailed = false;
    try {
      await store.record({
        timestamp: '',
        tenantId: 'test',
        action: 'tools/call',
        toolName: 'test',
        traceId: 'test',
        decision: 'allow'
      });
    } catch {
      recordFailed = true;
    }
    try {
      await store.close();
    } catch {
      closeFailed = true;
    }
    process.send?.({ recordFailed, closeFailed });
    process.disconnect();
  })();
}, 30);
