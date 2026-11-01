#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';

const marker = process.env.GITEA_AXI_BROWSER_CANARY;
assert(marker, 'Browser canary requires a marker path');
appendFileSync(marker, 'launched\n');
