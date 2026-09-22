#!/usr/bin/env node
// Content pipeline CLI: check | build | manifest | publish. Implemented by WO-7.
const [, , command] = process.argv;
console.log(`rearena-content ${command ?? ''}: not implemented yet (WO-7)`);
process.exit(command ? 0 : 1);
