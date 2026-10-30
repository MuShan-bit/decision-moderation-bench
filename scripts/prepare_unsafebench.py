#!/usr/bin/env python3
"""把 UnsafeBench parquet 转成本地 safe/unsafe 二分类图像评测集。

UnsafeBench 的原始图片与标注不入库（data/real-images/ 已在 .gitignore 中忽略）；
本脚本只负责在本地抽取图片、生成 `samples.jsonl`，供 `--dataset unsafebench` 跑分。

依赖（仅数据准备，运行时仍零依赖）：
    pip3 install pyarrow pillow

用法：
    python3 scripts/prepare_unsafebench.py \
      --parquet data/raw/unsafebench/data/test-00000-of-00001.parquet \
      --limit 50

输出：
    data/real-images/unsafebench/samples.jsonl
    data/real-images/unsafebench/ub-0001.jpg ...
"""

import argparse
import io
import json
import random
import sys
from collections import Counter
from pathlib import Path

try:
    import pyarrow.parquet as pq
    from PIL import Image
except ImportError as exc:  # pragma: no cover - 环境缺失时给出可执行提示
    sys.exit(
        f"缺少依赖：{exc.name}。请先运行：pip3 install pyarrow pillow"
    )

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "data" / "real-images" / "unsafebench"
TEXT_PROMPT = "这是一张用户上传的图片，请判断内容是否安全。"
MAX_BYTES = 4 * 1024 * 1024


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="UnsafeBench -> safe/unsafe 本地图像评测集")
    parser.add_argument(
        "--parquet",
        default=str(ROOT / "data/raw/unsafebench/data/test-00000-of-00001.parquet"),
        help="UnsafeBench parquet 路径（默认 test split）",
    )
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="输出目录")
    parser.add_argument("--limit", type=int, default=50, help="抽取图片数（默认 50；0 表示全部）")
    parser.add_argument("--seed", type=int, default=42, help="随机种子（默认 42）")
    parser.add_argument("--max-bytes", type=int, default=MAX_BYTES, help="单张图片大小上限（默认 4MiB）")
    parser.add_argument("--force", action="store_true", help="输出目录非空时覆盖")
    parser.add_argument("--quiet", action="store_true", help="只输出错误")
    return parser.parse_args()


def save_image(raw: bytes, dest: Path, max_bytes: int) -> None:
    """解码并重编码为 JPEG；必要时降质量/缩放，保证单张 <= max_bytes。"""
    with Image.open(io.BytesIO(raw)) as img:
        img = img.convert("RGB")
        for quality, scale in ((92, 1.0), (88, 1.0), (84, 0.85), (80, 0.7), (75, 0.55)):
            target = img
            if scale < 1.0:
                target = img.resize(
                    (max(1, int(img.width * scale)), max(1, int(img.height * scale))),
                    Image.LANCZOS,
                )
            buffer = io.BytesIO()
            target.save(buffer, format="JPEG", quality=quality, optimize=True)
            payload = buffer.getvalue()
            if len(payload) <= max_bytes:
                dest.write_bytes(payload)
                return
    raise ValueError(f"无法压到 {max_bytes} 字节以内：{dest.name}")


def pick_rows(rows: list[dict], limit: int, seed: int) -> list[dict]:
    rng = random.Random(seed)
    unsafe = [row for row in rows if str(row.get("safety_label", "")).strip().lower() == "unsafe"]
    safe = [row for row in rows if str(row.get("safety_label", "")).strip().lower() == "safe"]
    if not unsafe or not safe:
        raise SystemExit("parquet 中缺少 safe 或 unsafe 样本")

    if limit and limit > 0:
        if limit < 2:
            raise SystemExit("--limit 至少为 2（保持 safe/unsafe 各至少 1 条）")
        unsafe_n = min(len(unsafe), limit // 2)
        safe_n = min(len(safe), limit - unsafe_n)
        # 如果某一类不够，用另一类补齐，最多到 limit
        if unsafe_n + safe_n < limit:
            unsafe_n = min(len(unsafe), limit - safe_n)
        if unsafe_n + safe_n < limit:
            safe_n = min(len(safe), limit - unsafe_n)
        if unsafe_n + safe_n < limit:
            raise SystemExit(f"可用样本不足：需要 {limit} 条，只有 {unsafe_n + safe_n} 条")
        unsafe = rng.sample(unsafe, unsafe_n)
        safe = rng.sample(safe, safe_n)

    selected = unsafe + safe
    rng.shuffle(selected)
    return selected


def main() -> int:
    args = parse_args()
    parquet = Path(args.parquet).expanduser().resolve()
    if not parquet.is_file():
        sys.exit(f"parquet 不存在：{parquet}")

    out_dir = Path(args.out).expanduser().resolve()
    if out_dir.exists() and any(out_dir.iterdir()):
        if not args.force:
            sys.exit(f"输出目录非空：{out_dir}；确认覆盖请加 --force")
        for item in out_dir.iterdir():
            if item.is_file():
                item.unlink()

    table = pq.read_table(parquet)
    required = {"image", "safety_label", "category", "source"}
    missing = required - set(table.column_names)
    if missing:
        sys.exit(f"parquet 缺少字段：{', '.join(sorted(missing))}")
    rows = table.to_pylist()
    selected = pick_rows(rows, args.limit, args.seed)

    out_dir.mkdir(parents=True, exist_ok=True)
    records = []
    label_counts = Counter()
    for index, row in enumerate(selected, start=1):
        image = row.get("image") or {}
        raw = image.get("bytes") if isinstance(image, dict) else None
        if not raw:
            continue
        sample_id = f"ub-{index:04d}"
        image_name = f"{sample_id}.jpg"
        save_image(raw, out_dir / image_name, args.max_bytes)

        unsafe = str(row.get("safety_label", "")).strip().lower() == "unsafe"
        category = str(row.get("category", "")).strip() or "unknown"
        source = str(row.get("source", "")).strip() or "unknown"
        label_counts["unsafe" if unsafe else "safe"] += 1
        records.append(
            {
                "id": sample_id,
                "image": image_name,
                "text": TEXT_PROMPT,
                "source": "unsafebench",
                "source_detail": f"UnsafeBench / {category} / {source}",
                "unsafebench_category": category,
                "unsafebench_source": source,
                "origin": "benchmark-augmented",
                "sensitive": unsafe,
                "gold": {
                    "violation": 1 if unsafe else 0,
                    "categories": ["unsafe"] if unsafe else ["safe"],
                },
            }
        )

    if not records:
        sys.exit("没有可写入的样本")
    samples_path = out_dir / "samples.jsonl"
    with samples_path.open("w", encoding="utf-8") as fh:
        for record in records:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")

    if not args.quiet:
        print(f"parquet : {parquet}")
        print(f"输出目录: {out_dir}")
        print(f"样本数  : {len(records)}（safe {label_counts['safe']} / unsafe {label_counts['unsafe']}）")
        print(f"清单    : {samples_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
