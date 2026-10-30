// 聚合入口：Node 24 的 `node --test <dir>` 会把目录参数当成单个测试文件执行，
// 因此提供 index.js 汇总全部测试，保证 `node --test tests/` 与 `npm test` 可直接使用。
import './env.test.mjs';
import './moderation.test.mjs';
import './metrics.test.mjs';
import './dataset.test.mjs';
import './mock.test.mjs';
import './providers.test.mjs';
import './cloudflare.test.mjs';
import './images.test.mjs';
import './server.test.mjs';

import './real-images.test.mjs';
