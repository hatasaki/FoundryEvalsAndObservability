"""evaluate.py の CI 支援: ベースライン互換性、結果待ち、スコアレポート。

デモの理解にこのコードは不要。compare_to_baseline.py はレポート JSON でゲート判定する。
"""

import hashlib
import json
import time
from math import isfinite
from pathlib import Path
from statistics import fmean

from compare_to_baseline import provenance_errors
from openai import OpenAI


def fingerprint(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def provenance(rows: list[dict], evaluation: dict) -> dict:
    """スコアの前提となる、質問の内容と各評価器の定義・入力を記録する。"""
    return {
        "dataset_sha256": fingerprint(rows),
        "judges": {
            criterion["name"]: {
                "evaluator_name": criterion["evaluator_name"],
                "definition_sha256": fingerprint(
                    json.loads(
                        (Path(__file__).parent / f"{criterion['evaluator_name']}.json").read_text()
                    )["definition"]
                ),
                "initialization_parameters": criterion["initialization_parameters"],
                "data_mapping": criterion["data_mapping"],
            }
            for criterion in evaluation["testing_criteria"]
        },
    }


def check_baseline(baseline: Path, rows: list[dict], evaluation: dict) -> None:
    errors = provenance_errors(
        {"provenance": provenance(rows, evaluation)}, json.loads(baseline.read_text())
    )
    if errors:
        raise SystemExit("FAIL: " + "\n".join(errors))


def judge_problems(client: OpenAI, run_id: str, eval_id: str, name: str) -> list[str]:
    """評価器がエラーを起こした、または採点しなかった質問とその詳細を返す。"""
    lines = [f"{name} が採点しなかった質問:"]
    for item in client.evals.runs.output_items.list(run_id, eval_id=eval_id, limit=100):
        data = item.model_dump(warnings=False)
        question = (data.get("datasource_item") or {}).get("name", item.id)
        for result in data.get("results") or []:
            if result.get("name") != name:
                continue
            if result.get("status") not in (None, "completed") or result.get("error"):
                error = result.get("error") or (result.get("sample") or {}).get("error")
                if isinstance(error, dict):
                    error = error.get("message", error)
                detail = error or result.get("reason") or result.get("status")
                lines.append(f"  {question}: {str(detail)[:300]}")
    return lines


def wait_for_evaluation(
    client: OpenAI,
    run_id: str,
    *,
    agent_name: str,
    evaluation: dict,
    rows: list[dict],
    report_path: Path | None,
    max_unscored: int = 0,
) -> None:
    eval_id = evaluation["id"]
    expected_rows = len(rows)
    expected_criteria = {criterion["name"] for criterion in evaluation["testing_criteria"]}
    report = {
        "agent_name": agent_name,
        "eval_id": eval_id,
        "run_id": run_id,
        "status": None,
        "results_complete": False,
        "provenance": provenance(rows, evaluation),
        "evaluator_versions": {
            criterion["name"]: criterion["evaluator_version"]
            for criterion in evaluation["testing_criteria"]
        },
    }

    deadline = time.monotonic() + 3600
    run = client.evals.runs.retrieve(run_id, eval_id=eval_id)
    while run.status in ("queued", "in_progress"):
        report["status"] = run.status
        if report_path:
            report_path.write_text(json.dumps(report, indent=2) + "\n")
        if time.monotonic() >= deadline:
            raise TimeoutError(
                f"評価 {run_id} が60分以内に完了しませんでした。まだ実行中の可能性があります。"
            )
        print(f"評価の完了待ち: {run.status}", flush=True)
        time.sleep(30)
        run = client.evals.runs.retrieve(run_id, eval_id=eval_id)

    # サービスの完了と、集計・結果一覧の反映は同時とは限らない。
    results_deadline = min(deadline, time.monotonic() + 300)
    while True:
        report["status"] = run.status
        report["report_url"] = run.report_url
        report["result_counts"] = run.result_counts.model_dump()
        if report_path:
            report_path.write_text(json.dumps(report, indent=2) + "\n")
        if run.status != "completed":
            raise RuntimeError(f"評価 {run_id} が状態 {run.status} で終了しました: {run.error}")
        if run.error is not None:
            raise RuntimeError(f"評価 {run_id} がエラーで終了しました: {run.error}")
        items = list(client.evals.runs.output_items.list(run_id, eval_id=eval_id, limit=100))
        total = run.result_counts.total
        if total > expected_rows or len(items) > expected_rows:
            raise RuntimeError(
                f"評価結果が想定の{expected_rows}件を超えました: 集計{total}件、明細{len(items)}件"
            )
        if total == expected_rows and len(items) == expected_rows:
            break
        remaining = results_deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(
                f"評価 {run_id} の結果反映が待機期限を超えました: "
                f"集計{total}/{expected_rows}件、明細{len(items)}/{expected_rows}件"
            )
        print(
            f"評価結果の反映待ち: 集計{total}/{expected_rows}件、"
            f"明細{len(items)}/{expected_rows}件",
            flush=True,
        )
        time.sleep(min(30, remaining))
        run = client.evals.runs.retrieve(run_id, eval_id=eval_id)

    scores: dict[str, list[float]] = {name: [] for name in expected_criteria}
    passes = dict.fromkeys(expected_criteria, 0)
    unscored = dict.fromkeys(expected_criteria, 0)
    # エージェントは全問に回答する必要がある。評価器の未採点は --max-unscored で許容する。
    for item in items:
        if item.sample.error is not None:
            raise RuntimeError(
                f"評価ケース {item.id} でエージェントが失敗しました: {item.sample.error}"
            )
        results = {r.get("name"): r for r in item.model_dump(warnings=False)["results"] or []}
        for name in expected_criteria:
            result = results.get(name, {})
            score, passed = result.get("score"), result.get("passed")
            if (
                result.get("status") not in (None, "completed")
                or result.get("error") is not None
                or not isinstance(score, (int, float))
                or isinstance(score, bool)
                or not isfinite(score)
                or not isinstance(passed, bool)
            ):
                unscored[name] += 1
                continue
            scores[name].append(score)
            passes[name] += int(passed)

    for name, missed in unscored.items():
        if missed == 0:
            continue
        for line in judge_problems(client, run_id, eval_id, name):
            print(line, flush=True)
        if missed > max_unscored:
            raise RuntimeError(
                f"{name} の未採点が {missed} 件あり、--max-unscored {max_unscored} を超えました。"
                "詳細は上記を確認してください。429 は評価モデルのレート制限です。"
                "再実行してください。401 はアカウントレベルの Foundry User 権限の不足です"
                "（新しい権限の反映には約10分かかります）。"
            )
        print(
            f"警告: {name} の未採点が {missed} 件あります。"
            f"平均には残りの {expected_rows - missed} 件を使います。",
            flush=True,
        )

    report["criteria"] = [
        {
            "name": name,
            "mean_score": fmean(scores[name]),
            "passed": passes[name],
            "failed": len(scores[name]) - passes[name],
            "total": len(scores[name]),
            "unscored": unscored[name],
        }
        for name in sorted(expected_criteria)
    ]
    report["results_complete"] = True
    if report_path:
        report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2), flush=True)
