const mode = process.argv[2];
if (mode === 'output') {
  process.stdout.write('x'.repeat(4096));
} else if (mode === 'hang') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 100);
} else {
  process.stderr.write('unknown fixture mode');
  process.exit(3);
}
import process from 'node:process';
import { setInterval } from 'node:timers';
