#!/usr/bin/env node
import { runCli } from './entrypoints/cli.js';
process.exitCode = await runCli(process.argv.slice(2));
