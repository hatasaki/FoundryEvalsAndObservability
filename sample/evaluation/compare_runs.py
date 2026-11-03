"""評価実行を質問ごとに比較する。変更で実際に改善した点と悪化した点は何か。

旧バージョン（A）と新バージョン（B）の実行を、それぞれ1件以上指定する。回答は変動するため、
複数回の実行が望ましい。A の全実行で失敗し、B の全実行で合格した質問だけを改善と数える。
各実行には、Foundry からエクスポートした結果ファイル（.jsonl）、またはプロジェクトの
EVAL_ID:RUN_ID を指定する。

sample/ から実行する:

    # 1. 実行を探す（evaluate.py と同様、FOUNDRY_PROJECT_ENDPOINT が必要）:
    python evaluation/compare_runs.py --list

    # 2. ベースライン2回と新しいプロンプト2回を比較する:
    python evaluation/compare_runs.py \\
        --a EVAL_ID:RUN_ID_1 EVAL_ID:RUN_ID_2 \\
        --b EVAL_ID:RUN_ID_3 EVAL_ID:RUN_ID_4

    # エクスポート済みファイルでも同様に比較できる。Azure へのアクセスは不要:
    python evaluation/compare_runs.py --a old-1.jsonl old-2.jsonl --b new-1.jsonl new-2.jsonl

B で改善した質問、悪化した質問、結果が不安定な質問（同じ側の実行間で結果が異なるもの）を
表示する。改善した質問の本文も表示するため、ライブデモの質問候補を選べる。
"""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

JUDGE = "next_action_success"


def rows_from_file(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def openai_client():
    from azure.ai.projects import AIProjectClient
    from azure.identity import DefaultAzureCredential

    endpoint = os.environ.get("FOUNDRY_PROJECT_ENDPOINT", "").strip()
    if not endpoint.startswith("https://"):
        sys.exit(
            "FOUNDRY_PROJECT_ENDPOINT が未設定です。sample/ から次を実行してください:\n"
            '  export FOUNDRY_PROJECT_ENDPOINT="$(azd env get-value FOUNDRY_PROJECT_ENDPOINT)"'
        )
    project = AIProjectClient(endpoint=endpoint, credential=DefaultAzureCredential())
    return project.get_openai_client()


def rows_from_run(client, ref: str) -> list[dict]:
    eval_id, _, run_id = ref.partition(":")
    if not run_id:
        sys.exit(
            f"{ref!r}: EVAL_ID:RUN_ID（--list で確認）、または .jsonl ファイルを指定してください。"
        )
    items = client.evals.runs.output_items.list(run_id, eval_id=eval_id, limit=100)
    return [item.model_dump(warnings=False) for item in items]


def load(refs: list[str], client_box: list) -> list[dict[str, tuple[bool | None, str]]]:
    """実行ごとに {質問名: (合否, 質問文)} を返す。評価器が採点していない場合は None。"""
    runs = []
    for ref in refs:
        if ref.endswith(".jsonl"):
            rows = rows_from_file(Path(ref))
        else:
            if not client_box:
                client_box.append(openai_client())
            rows = rows_from_run(client_box[0], ref)
        run = {}
        for row in rows:
            item = row.get("datasource_item") or {}
            judged = [r for r in row.get("results") or [] if r.get("name") == JUDGE]
            passed = judged[0].get("passed") if judged else None
            run[item.get("name", row.get("id"))] = (passed, item.get("query", ""))
        runs.append(run)
    return runs


def list_runs() -> None:
    client = openai_client()
    print(f"{'実行（--a / --b に指定）':<75} {'作成日時':<17} 合格件数")
    for evaluation in client.evals.list(limit=20, order="desc"):
        for run in client.evals.runs.list(evaluation.id, limit=10, order="desc"):
            counts = run.result_counts
            created = datetime.fromtimestamp(run.created_at)
            passed = f"{counts.passed}/{counts.total}" if counts else "-"
            print(f"{evaluation.id}:{run.id:<40} {created:%d %b %H:%M}  {passed}  {run.name}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--list", action="store_true", help="最近の実行を一覧して終了する。")
    parser.add_argument("--a", nargs="+", default=[], help="旧バージョンの実行。")
    parser.add_argument("--b", nargs="+", default=[], help="新バージョンの実行。")
    args = parser.parse_args()
    if args.list:
        list_runs()
        return
    if not args.a or not args.b:
        parser.error(
            "--a と --b にそれぞれ1件以上の実行を指定してください（または --list を使用）。"
        )

    box: list = []
    a_runs, b_runs = load(args.a, box), load(args.b, box)
    names = sorted(set().union(*a_runs, *b_runs))
    text = {n: q for run in a_runs + b_runs for n, (_, q) in run.items() if q}

    def marks(runs, name):
        return [run.get(name, (None, ""))[0] for run in runs]

    fixed, broken, flaky = [], [], []
    for name in names:
        a, b = marks(a_runs, name), marks(b_runs, name)
        if None in a or None in b:
            continue
        if len(set(a)) > 1 or len(set(b)) > 1:
            flaky.append(name)
        elif a[0] is False and b[0] is True:
            fixed.append(name)
        elif a[0] is True and b[0] is False:
            broken.append(name)

    def score(runs):
        results = [p for run in runs for p, _ in run.values() if p is not None]
        return f"{sum(results)}/{len(results)} 件合格"

    print(f"A ({len(a_runs)} 回): {score(a_runs)}    B ({len(b_runs)} 回): {score(b_runs)}")
    print(f"評価器: {JUDGE}。各側の全実行で結果が一致した質問だけを改善・悪化に数えます。")
    if len(a_runs) == 1 or len(b_runs) == 1:
        print(
            "注意: 片側が1回だけでは、改善・悪化を実行間のノイズと区別できません。\n"
            "各側を2回以上実行すると、結果が変動する質問は不安定として表示されます。"
        )
    print()
    for title, group in (("B で改善", fixed), ("B で悪化", broken), ("不安定", flaky)):
        print(f"{title} ({len(group)}):")
        for name in group:
            print(f"  {name}   A {marks(a_runs, name)}  B {marks(b_runs, name)}")
        print()
    if fixed:
        print("デモの質問候補（A の全実行で失敗し、B の全実行で合格）:")
        for name in fixed:
            print(f"  {name}\n    {text.get(name, '')}")


if __name__ == "__main__":
    main()
