#!/usr/bin/env node
'use strict';
// Entry point of the `agent-office` command. The CLI is compiled into ../dist/cli.cjs by
// `npm run build`; this file exists before the first build so npm can link the command.
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const cli = join(__dirname, '..', 'dist', 'cli.cjs');
if (!existsSync(cli)) {
  process.stderr.write('agent-office is not built yet. Run "npm run build" in the repository first.\n');
  process.exit(1);
}
require(cli);
