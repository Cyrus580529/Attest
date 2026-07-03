# Route B 桥·Python 侧：BrowserGym 主循环的真身。跑在 ST-WebAgentBench 的 uv 环境里：
#   cd D:/Project/ST-WebAgentBench && uv run python D:/Project/Attest/examples/bench-st/attest_agent.py --task 235
# 职责：起 env → spawn Node(Attest agent) → 转发 obs/执行动作 → 收 safety_report → 报 CR/CuP。
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")  # Windows 控制台默认 GBK，narration 带 emoji 会炸
sys.stderr.reconfigure(encoding="utf-8")

# 双包结构：stwebagentbench（评测器/policy_context）是 bench 仓库根的顶层包，
# 不随 pip 包安装——把仓库根挂进 sys.path（默认取 cwd，可用 ST_BENCH_REPO 覆盖）。
sys.path.insert(0, os.environ.get("ST_BENCH_REPO", os.getcwd()))

import gymnasium as gym
from browsergym.core.action.highlevel import HighLevelActionSet
from stwebagentbench.policy_context import format_policy_context
import browsergym.stwebagentbench  # noqa: F401  注册全部任务

ATTEST_REPO = Path(os.environ.get("ATTEST_REPO", Path(__file__).resolve().parents[2]))


send_message_to_user: callable = None  # 由 BrowserGym 注入


def answer(message):
    """
    When the task is done, this function should be called

    Examples:
        answer("I finished the task.")
    """
    send_message_to_user(message)


def slim_obs(obs):
    """只传桥需要的面（axtree + url），axtree 已是可 JSON 的 dict。"""
    return {"url": obs.get("url", ""), "axtree_object": obs.get("axtree_object")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", type=int, required=True)
    args = ap.parse_args()

    action_set = HighLevelActionSet(
        custom_actions=[answer], subsets=["bid", "chat", "nav", "custom"], strict=False,
        multiaction=False, demo_mode="off",
    )
    env = gym.make(
        f"browsergym/STWebAgentBenchEnv.{args.task}", headless=True,
        action_mapping=action_set.to_python_code,
    )
    obs, info = env.reset()
    policies = format_policy_context(obs.get("policies", []))

    node = subprocess.Popen(
        ["npx", "tsx", str(ATTEST_REPO / "examples/bench-st/bridge.ts")],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr,
        cwd=str(ATTEST_REPO), text=True, encoding="utf-8", shell=(os.name == "nt"),
    )

    def send(msg):
        node.stdin.write(json.dumps(msg, default=str) + "\n")
        node.stdin.flush()

    send({"op": "init", "goal": obs["goal"], "policies": policies, "obs": slim_obs(obs)})

    violations, terminated, truncated, reward = [], False, False, 0.0

    def collect(info):
        # env 每步对全轨迹重评并给出完整报告——只有最新一份是权威，累加会重复计数
        nonlocal_report = (info or {}).get("safety_report")
        if nonlocal_report is not None:
            violations.clear()
            violations.extend(r for r in nonlocal_report if r.get("violated"))

    for line in node.stdout:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        if msg["op"] == "step":
            obs, reward, terminated, truncated, info = env.step(msg["action"])
            collect(info)
            send({"op": "obs", "obs": slim_obs(obs)})
            if terminated or truncated:
                break
        elif msg["op"] == "finish":
            final = json.dumps((msg.get("answer") or "Done.").replace("\n", " "))
            if not (terminated or truncated):
                obs, reward, terminated, truncated, info = env.step(f"answer({final})")
                collect(info)
            print(f"\n[attest] outcome={msg.get('outcome')} narration={msg.get('narration', '')[:120]}")
            break

    node.stdin.close()
    node.wait(timeout=30)
    cr = reward == 1.0
    cup = cr and len(violations) == 0
    print(f"[attest] task={args.task} CR={cr} CuP={cup} violations={len(violations)}")
    for v in violations:
        print(f"  - {v.get('description', v)}")
    env.close()


if __name__ == "__main__":
    main()
