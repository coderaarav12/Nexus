import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-'));
process.env.DATA_DIR = dir;
process.env.TOKEN_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
process.env.CHUNK_SIZE = '4096';
process.env.CHUNK_BUFFER_LIMIT = '8192';
process.env.HEARTBEAT_INTERVAL_MS = '3600000';
process.env.NODE_TIMEOUT_MULTIPLIER = '10';
process.env.MAX_CONCURRENT_TRANSFERS_PER_NODE = '1';
