#!/usr/bin/env node
// `decisionkit` with no arguments is the MCP server (what MCP clients spawn);
// with a subcommand it is the CLI.
import { runCli } from "./cli.ts";
import { serve } from "./server.ts";

const args = process.argv.slice(2);
if (args.length === 0) await serve();
else process.exitCode = await runCli(args);
