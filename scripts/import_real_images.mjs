#!/usr/bin/env node
/**
 * 导入本地真实图像（如 NSFW 实拍图）为评测集。
 *
 * 真实图像不入库：默认输出到 data/real-images/（已在 .gitignore 忽略），
 * 仓库只提交本脚本与文档；图片与标注由使用者本地提供，并自行确认来源/许可证合规。
 *
 * 用法：
 *   node scripts/import_real_images.mjs \
 *     --src /path/to/images --labels /path/to/labels.csv --out data/real-images
 *
 * labels.csv 表头（逗号分隔；file 为相对 --src 的路径）：
 *   file,violation,category,sensitive,source_detail
 *   a.jpg,1,sexual,1,自建 NSFW 评测集 / 明确裸露
 *   b.jpg,0,safe,0,自建 NSFW 评测集 / 正常
 *
 * labels.jsonl 也支持（每行一个对象，字段同名）。生成后可直接：
 *   node scripts/benchmark.mjs --provider cloudflare --model clef-omni \
 *     --dataset nsfw-image --concurrency 2
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { TAXONOMY_CODES } from '../server/moderation.mjs';
import { normalizeSample } from '../server/dataset.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');

const DEFAULT_OUT = 'data/real-images';
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const TEXT_PROMPT = '这是一张用户上传的图片，请审核图片中的内容。';
const CATEGORY_SET = new Set(TAXONOMY_CODES);

const HELP = `真实图像评测集导入（本地图片，不入库）

用法：
  node scripts/import_real_images.mjs --src <图片目录> --labels <标注文件> [选项]

选项：
      --src <dir>          图片所在目录（必填）
      --labels <file>      标注文件：.csv 或 .jsonl（必填）
      --out <dir>          输出目录（默认：${DEFAULT_OUT}）
      --prefix <name>      样本 id 前缀（默认：real）
      --max-bytes <n>      单张图片大小上限（默认：${DEFAULT_MAX_BYTES}，即 4MiB）
      --limit <n>          只导入前 n 条标注（调试用）
      --force              输出已存在时覆盖
  -h, --help               显示帮助

标注格式（CSV 表头 / JSONL 字段）：
  file,violation,category,sensitive,source_detail
  - file：相对 --src 的文件路径，扩展名须为 png / jpg / jpeg / webp
  - violation：1/0 或 true/false；1 时 category 必须是违规类别，0 时强制为 safe
  - category：insult | hate | sexual | violence | illegal | spam | privacy | safe
  - sensitive：可选，1/0；缺省时 sexual 视为 1，其余视为 0
  - source_detail：可选，写入样本展示来源

示例：
  node scripts/import_real_images.mjs --src ~/nsfw-eval/images --labels ~/nsfw-eval/labels.csv
  node scripts/benchmark.mjs --provider cloudflare --model clef-omni \\
    --dataset nsfw-image --concurrency 2
`;

function fail(message) {
  process.stderr.write(`错误：${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    src: null,
    labels: null,
    out: DEFAULT_OUT,
    prefix: 'real',
    maxBytes: DEFAULT_MAX_BYTES,
    limit: undefined,
    force: false,
    help: false,
  };
  const take = (i, flag) => {
    const value = argv[i + 1];
    if (!value || value.startsWith('-')) fail(`缺少 ${flag} 的值`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--src':
        options.src = take(i, arg);
        i += 1;
        break;
      case '--labels':
        options.labels = take(i, arg);
        i += 1;
        break;
      case '--out':
        options.out = take(i, arg);
        i += 1;
        break;
      case '--prefix': {
        const value = take(i, arg);
        if (!/^[A-Za-z0-9._-]{1,32}$/.test(value)) fail('--prefix 只允许字母、数字、点、下划线、短横线');
        options.prefix = value;
        i += 1;
        break;
      }
      case '--max-bytes': {
        const value = Number(take(i, arg));
        if (!Number.isSafeInteger(value) || value <= 0) fail('--max-bytes 必须是正整数');
        options.maxBytes = value;
        i += 1;
        break;
      }
      case '--limit': {
        const value = Number(take(i, arg));
        if (!Number.isInteger(value) || value <= 0) fail('--limit 必须是正整数');
        options.limit = value;
        i += 1;
        break;
      }
      case '--force':
        options.force = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        fail(`未知参数：${arg}（--help 查看用法）`);
    }
  }
  return options;
}

/** 极简 CSV 解析：支持双引号、字段内逗号/换行、"" 转义 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => String(cell).trim() !== ''));
}

/** 读取标注文件为对象数组（CSV/JSONL 自动识别） */
export function parseLabelsFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const trimmed = raw.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return [];
  const isJsonl = /\.jsonl?$/i.test(filePath);
  if (isJsonl) {
    return trimmed.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`标注第 ${index + 1} 行不是合法 JSON：${error.message}`);
      }
    });
  }
  const rows = parseCsv(trimmed);
  if (rows.length < 2) throw new Error('标注文件只有表头，没有数据行');
  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const required = ['file', 'violation', 'category'];
  for (const name of required) {
    if (!header.includes(name)) throw new Error(`标注文件缺少列：${name}`);
  }
  return rows.slice(1).map((cells) => {
    const record = {};
    header.forEach((name, i) => {
      record[name] = (cells[i] ?? '').trim();
    });
    return record;
  });
}

/** 检测真实图片类型；只认 PNG / JPEG / WebP */
export function detectImageType(headerBytes) {
  const buf = headerBytes;
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: '.png', mime: 'image/png' };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: '.jpg', mime: 'image/jpeg' };
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { ext: '.webp', mime: 'image/webp' };
  }
  return null;
}

function parseBool(raw, field, rowNo) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === '' || value === undefined) return undefined;
  if (['1', 'true', 'yes', 'y', '是'].includes(value)) return true;
  if (['0', 'false', 'no', 'n', '否'].includes(value)) return false;
  throw new Error(`第 ${rowNo} 行 ${field} 只能是 1/0/true/false`);
}

function assertInside(baseDir, targetPath) {
  const base = path.resolve(baseDir) + path.sep;
  const target = path.resolve(targetPath);
  if (target !== path.resolve(baseDir) && !target.startsWith(base)) {
    throw new Error(`图片路径越界：${targetPath}`);
  }
  return target;
}

/**
 * 校验并导入真实图像，生成本地评测集（图片复制到 outDir，清单写 outDir/samples.jsonl）。
 * @param {{
 *   srcDir: string,
 *   labelsPath: string,
 *   outDir?: string,
 *   prefix?: string,
 *   maxBytes?: number,
 *   limit?: number,
 *   force?: boolean,
 * }} options
 */
export function importRealImages(options = {}) {
  const srcDir = path.resolve(ROOT, options.srcDir || '');
  const labelsPath = path.resolve(ROOT, options.labelsPath || '');
  const outDir = path.resolve(ROOT, options.outDir || DEFAULT_OUT);
  const prefix = options.prefix || 'real';
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const force = options.force === true;

  if (!options.srcDir) throw new Error('必须指定 --src（图片目录）');
  if (!options.labelsPath) throw new Error('必须指定 --labels（标注文件）');
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    throw new Error(`图片目录不存在或不是目录：${srcDir}`);
  }
  if (!fs.existsSync(labelsPath)) throw new Error(`标注文件不存在：${labelsPath}`);

  const labels = parseLabelsFile(labelsPath);
  if (!labels.length) throw new Error('标注文件没有数据行');
  const selected = options.limit ? labels.slice(0, options.limit) : labels;

  // 先整体校验，全部通过后再落盘，避免留下半套数据。
  const prepared = [];
  const seenFiles = new Set();
  selected.forEach((label, index) => {
    const rowNo = index + 1;
    const fileRaw = typeof label.file === 'string' ? label.file.trim() : '';
    if (!fileRaw) throw new Error(`第 ${rowNo} 行缺少 file`);
    if (seenFiles.has(fileRaw)) throw new Error(`第 ${rowNo} 行图片重复：${fileRaw}`);
    seenFiles.add(fileRaw);

    const extRaw = path.extname(fileRaw).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extRaw)) {
      throw new Error(`第 ${rowNo} 行图片扩展名不支持：${fileRaw}（仅 png/jpg/jpeg/webp）`);
    }
    let srcPath;
    try {
      srcPath = assertInside(srcDir, path.join(srcDir, fileRaw));
    } catch {
      throw new Error(`第 ${rowNo} 行图片路径越界：${fileRaw}`);
    }
    if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) {
      throw new Error(`第 ${rowNo} 行图片不存在：${srcPath}`);
    }
    const size = fs.statSync(srcPath).size;
    if (size > maxBytes) {
      throw new Error(`第 ${rowNo} 行图片超过大小上限：${fileRaw}（${size} > ${maxBytes} bytes）`);
    }
    const fd = fs.openSync(srcPath, 'r');
    const head = Buffer.alloc(12);
    let read = 0;
    try {
      read = fs.readSync(fd, head, 0, head.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    const detected = detectImageType(head.subarray(0, read));
    if (!detected) throw new Error(`第 ${rowNo} 行不是有效图片：${fileRaw}`);
    if (detected.ext !== extRaw && !(detected.ext === '.jpg' && extRaw === '.jpeg')) {
      throw new Error(`第 ${rowNo} 行扩展名与内容不一致：${fileRaw}（实际 ${detected.ext}）`);
    }

    const violation = parseBool(label.violation, 'violation', rowNo);
    if (violation === undefined) throw new Error(`第 ${rowNo} 行缺少 violation`);
    const categoryRaw = String(label.category ?? '').trim().toLowerCase();
    let category;
    if (!violation) {
      category = 'safe';
    } else {
      if (!categoryRaw) throw new Error(`第 ${rowNo} 行 violation=1 但缺少 category`);
      if (!CATEGORY_SET.has(categoryRaw) || categoryRaw === 'safe') {
        throw new Error(`第 ${rowNo} 行 category 非法：${categoryRaw}`);
      }
      category = categoryRaw;
    }

    const sensitiveRaw = parseBool(label.sensitive, 'sensitive', rowNo);
    const sensitive = sensitiveRaw === undefined ? category === 'sexual' : sensitiveRaw;
    const sourceDetail =
      typeof label.source_detail === 'string' && label.source_detail.trim()
        ? label.source_detail.trim()
        : `真实图像 / ${category}`;

    const id = `${prefix}-${String(index + 1).padStart(4, '0')}`;
    const imageName = `${id}${detected.ext}`;
    prepared.push({ id, imageName, srcPath, size, category, violation, sensitive, sourceDetail });
  });

  if (fs.existsSync(outDir)) {
    const existing = fs.readdirSync(outDir).filter((name) => name !== '.DS_Store');
    if (existing.length && !force) {
      throw new Error(`输出目录非空：${outDir}；确认覆盖请加 --force`);
    }
  }
  fs.mkdirSync(outDir, { recursive: true });

  const samples = prepared.map((item) => ({
    id: item.id,
    image: item.imageName,
    text: TEXT_PROMPT,
    source: 'real',
    source_detail: item.sourceDetail,
    origin: 'human',
    sensitive: item.sensitive,
    gold: {
      violation: item.violation,
      categories: [item.category],
    },
  }));

  // 用正式加载器兜底校验，保证生成的清单能直接被 benchmark 读取。
  for (let i = 0; i < samples.length; i += 1) {
    const normalized = normalizeSample(samples[i]);
    if (!normalized) throw new Error(`第 ${i + 1} 条生成的样本未通过 dataset 校验`);
  }

  for (const item of prepared) {
    fs.copyFileSync(item.srcPath, path.join(outDir, item.imageName));
  }
  const manifestPath = path.join(outDir, 'samples.jsonl');
  fs.writeFileSync(manifestPath, samples.map((sample) => JSON.stringify(sample)).join('\n') + '\n');

  const stats = {};
  for (const item of prepared) stats[item.category] = (stats[item.category] || 0) + 1;
  return {
    outDir,
    manifestPath,
    total: prepared.length,
    sensitive: prepared.filter((item) => item.sensitive).length,
    bytes: prepared.reduce((sum, item) => sum + item.size, 0),
    stats,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!options.src) fail('缺少 --src（--help 查看用法）');
  if (!options.labels) fail('缺少 --labels（--help 查看用法）');

  let summary;
  try {
    summary = importRealImages({
      srcDir: options.src,
      labelsPath: options.labels,
      outDir: options.out,
      prefix: options.prefix,
      maxBytes: options.maxBytes,
      limit: options.limit,
      force: options.force,
    });
  } catch (error) {
    fail(error.message);
  }

  process.stdout.write('=== 真实图像评测集导入完成 ===\n');
  process.stdout.write(`输出目录   : ${summary.outDir}\n`);
  process.stdout.write(`样本清单   : ${summary.manifestPath}\n`);
  process.stdout.write(`样本数     : ${summary.total}（敏感打码 ${summary.sensitive}）\n`);
  process.stdout.write(`图片总大小 : ${(summary.bytes / 1024 / 1024).toFixed(2)} MB\n`);
  process.stdout.write(
    `类别分布   : ${Object.entries(summary.stats)
      .map(([category, count]) => `${category} ${count}`)
      .join(' / ')}\n`,
  );
  if (summary.total < 30) {
    process.stdout.write('⚠️ 样本量较小，分类别指标波动会很大；建议至少 100 张并保持正负样本均衡。\n');
  }
  process.stdout.write('\n下一步：\n');
  const manifestRel = path.relative(ROOT, summary.manifestPath);
  const manifestDisplay = manifestRel.startsWith('..') ? summary.manifestPath : manifestRel;
  process.stdout.write(
    `  node scripts/benchmark.mjs --provider cloudflare --model clef-omni --dataset ${manifestDisplay} --concurrency 2\n`,
  );
  process.stdout.write('\n提醒：真实图像仅在本地保存，请勿提交到公开仓库；请自行确认数据集许可证/使用条款。\n');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
