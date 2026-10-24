#!/usr/bin/env node
import { PackagerCli } from '../dist/cli/packager-cli.js';

PackagerCli.run(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error('Error:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
);
