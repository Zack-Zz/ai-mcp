import process from 'node:process';
import console from 'node:console';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('fixture-codex 1.0');
  process.exit(0);
}
if (args.includes('--help')) {
  console.log('exec resume --json --sandbox');
  process.exit(0);
}
if (args[0] === 'features' && args[1] === 'list') {
  console.log('shell_tool stable true\nunified_exec stable true');
  process.exit(0);
}
console.error('fixture does not execute model tasks');
process.exit(91);
