#!/usr/bin/env python3
"""Attest bench runner：批跑一段 ST-WebAgentBench 任务区间，每题重灌 DB、断点续跑，
落 results.csv（机械统计）+ summary.md（CR/CuP 比率、违规类型分布表）+ 每题一份 trace.jsonl。

定性分析（为什么这题这样、是不是新缺口）不在这里自动生成——那部分仍由人/LLM 写进
report.md，评测只诊断不定制（见 CLAUDE.md §二·五）。

用法：
  python bench_runner.py --tasks 265-294 --out-dir docs/bench/runs/crm-hard \
      --bench-repo D:/Project/ST-WebAgentBench

  python bench_runner.py --tasks 265,270,290 --out-dir docs/bench/runs/spot-check \
      --bench-repo D:/Project/ST-WebAgentBench --force
"""
import argparse
import csv
import json
import subprocess
import sys
import time
from pathlib import Path

ATTEST_REPO = Path(__file__).resolve().parents[2]
ATTEST_AGENT = ATTEST_REPO / "examples/bench-st/attest_agent.py"
SUMMARY_JSON_PREFIX = "[attest-json] "
OUTCOME_RE_PREFIX = "[attest] outcome="


def parse_tasks(spec: str) -> list[int]:
    """'265-294' → 30 个连续任务；'265,270,290' → 指定几个；也支持混合 '265-267,290'。"""
    out: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            start, end = part.split("-", 1)
            out.extend(range(int(start), int(end) + 1))
        elif part:
            out.append(int(part))
    return out


def reset_suitecrm_db(bench_repo: Path) -> None:
    """唯一已接入的 suite：SuiteCRM。DB 重灌命令写死在这——只有一个 suite 时不为"可插拔"
    过度设计，等第二个 suite 接入时再抽象（YAGNI）。"""
    snapshot = bench_repo / "suitecrm_setup/init-db/clean_snapshot.sql"
    with open(snapshot, "rb") as f:
        subprocess.run(
            ["docker", "exec", "-i", "suitecrm_setup-mariadb-1", "mysql",
             "-u", "bn_suitecrm", "-pbitnami123", "bitnami_suitecrm"],
            stdin=f, check=True, capture_output=True,
        )


def run_task(task_id: int, bench_repo: Path, trace_dir: Path, timeout: int) -> dict:
    bench_python = bench_repo / ".venv/Scripts/python.exe"
    trace_path = trace_dir / f"task{task_id}.jsonl"
    start = time.time()
    try:
        proc = subprocess.run(
            [str(bench_python), str(ATTEST_AGENT), "--task", str(task_id), "--trace-path", str(trace_path)],
            cwd=str(bench_repo), capture_output=True, text=True, encoding="utf-8", timeout=timeout,
        )
        elapsed = round(time.time() - start)
        summary = None
        outcome = ""
        for line in proc.stdout.splitlines():
            if line.startswith(SUMMARY_JSON_PREFIX):
                summary = json.loads(line[len(SUMMARY_JSON_PREFIX):])
            elif line.startswith(OUTCOME_RE_PREFIX):
                # "[attest] outcome=completed narration=..." —— 只要 outcome 那个词
                rest = line[len(OUTCOME_RE_PREFIX):]
                outcome = rest.split(" ", 1)[0]
        if summary is None:
            return {"task": task_id, "CR": "", "CuP": "", "violations": "",
                    "outcome": outcome, "status": "no-result", "seconds": elapsed}
        return {
            "task": task_id, "CR": summary["cr"], "CuP": summary["cup"],
            "violations": len(summary["violations"]), "outcome": outcome,
            "status": "ok", "seconds": elapsed,
        }
    except subprocess.TimeoutExpired:
        return {"task": task_id, "CR": "", "CuP": "", "violations": "",
                "outcome": "", "status": "timeout", "seconds": round(time.time() - start)}
    except Exception as e:
        return {"task": task_id, "CR": "", "CuP": "", "violations": "",
                "outcome": "", "status": f"error:{e}", "seconds": round(time.time() - start)}


def already_done(results_csv: Path) -> set[int]:
    if not results_csv.exists():
        return set()
    with open(results_csv, newline="", encoding="utf-8") as f:
        return {int(r["task"]) for r in csv.DictReader(f) if r["status"] == "ok"}


def write_summary_md(results_csv: Path, out_path: Path) -> None:
    """纯机械统计：CR/CuP 比率 + 违规 eval_type 分布。定性分析不在这生成。"""
    rows = list(csv.DictReader(open(results_csv, newline="", encoding="utf-8")))
    ok_rows = [r for r in rows if r["status"] == "ok" and r["CR"] != ""]
    total = len(ok_rows)
    cr = sum(1 for r in ok_rows if r["CR"] == "True")
    cup = sum(1 for r in ok_rows if r["CuP"] == "True")
    viol_total = sum(int(r["violations"]) for r in ok_rows if r["violations"] != "")
    lines = [
        "# Bench 批跑聚合（机械统计，定性分析见 report.md）",
        "",
        f"- 总题数：{total}（另有 {len(rows) - total} 题非 ok，见 results.csv 的 status 列）",
        f"- CR：{cr}/{total}" if total else "- CR：n/a",
        f"- CuP：{cup}/{total}" if total else "- CuP：n/a",
        f"- 违规总数：{viol_total}",
    ]
    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", required=True, help="任务区间，如 '265-294' 或 '265,270,290'")
    ap.add_argument("--out-dir", required=True, help="results.csv/summary.md/trace 的输出目录")
    ap.add_argument("--bench-repo", required=True, help="ST-WebAgentBench 仓库路径")
    ap.add_argument("--force", action="store_true", help="忽略断点续跑，全部重新跑")
    ap.add_argument("--timeout", type=int, default=600, help="单题超时秒数（默认600）")
    args = ap.parse_args()

    bench_repo = Path(args.bench_repo)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    trace_dir = out_dir / "traces"
    trace_dir.mkdir(exist_ok=True)
    results_csv = out_dir / "results.csv"

    tasks = parse_tasks(args.tasks)
    done = set() if args.force else already_done(results_csv)
    write_header = args.force or not results_csv.exists()
    mode = "w" if args.force else "a"
    fieldnames = ["task", "CR", "CuP", "violations", "outcome", "status", "seconds"]

    with open(results_csv, mode, newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        if write_header:
            writer.writeheader()
            f.flush()
        for task_id in tasks:
            if task_id in done:
                print(f"[skip] task {task_id} already done")
                continue
            print(f"[run] task {task_id}: resetting DB...")
            reset_suitecrm_db(bench_repo)
            print(f"[run] task {task_id}: running agent...")
            row = run_task(task_id, bench_repo, trace_dir, args.timeout)
            writer.writerow(row)
            f.flush()
            print(f"[done] task {task_id}: {row}")

    write_summary_md(results_csv, out_dir / "summary.md")
    print(f"summary written to {out_dir / 'summary.md'}")


if __name__ == "__main__":
    main()
