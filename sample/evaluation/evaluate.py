# ポリシーを引用できるかだけでなく、エージェントが示す次の行動を評価する。
# Foundry が各質問でデプロイ済みエージェントを呼び出し、その回答を評価器で採点する。
#
#   python evaluation/evaluate.py --dry-run    # リクエストを表示する。クラウド呼び出しはしない

import argparse
import json
import os
from contextlib import contextmanager
from pathlib import Path

from azure.ai.projects import AIProjectClient
from azure.identity import DefaultAzureCredential
from ci_report import check_baseline, wait_for_evaluation

HERE = Path(__file__).resolve().parent
AGENT_NAME = os.environ.get("AGENT_NAME", "purchasing-advice-demo")
JUDGE_MODEL = "gpt-5.5"
EVALUATOR_NAME = "purchasing-next-action"  # evaluation/purchasing-next-action.json
RUBRIC_NAME = "purchasing-demo-rubric"  # evaluation/purchasing-demo-rubric.json
# EVAL_DATASET により、CI でホールドアウトとドリフトも同じ評価器で実行できる。
DATASET = Path(os.environ.get("EVAL_DATASET", HERE / "datasets/approvers-development.jsonl"))


def main() -> None:
    args = parse_args()
    with connect(args.dry_run) as project:  # --dry-run の場合は None
        # 1. 評価器を作成する -> purchasing-next-action.json、purchasing-demo-rubric.json
        evaluators = create_evaluators(project, args.update_evaluators, args.register_only)
        if args.register_only:
            return

        # 2. 評価を定義する -> 各評価器に渡す項目を指定する
        evaluation = create_evaluation(project, evaluators)

        # 3. データセットを作成する -> datasets/approvers-development.jsonl
        rows, data_source = create_dataset(DATASET)

        # 4. 評価を実行する -> Foundry がエージェント、その後に評価器を呼び出す
        run_evaluation(project, evaluation, rows, data_source, args)


def create_evaluators(project, update: bool, register: bool) -> dict[str, str] | None:
    """各評価器を JSON から登録するか、一致する登録済みバージョンを再利用する。"""
    if project is None:
        return None
    return {
        name: ensure_evaluator(project, name, update=update, register=register)
        for name in (EVALUATOR_NAME, RUBRIC_NAME)
    }


def create_evaluation(project, evaluators: dict[str, str] | None) -> dict:
    """各評価器への入力を定義する。エージェントには質問だけを渡す（手順3）。"""
    evaluation = {
        "name": f"purchasing-next-action-evaluation-{DATASET.stem}",
        "data_source_config": {
            "type": "custom",
            "item_schema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "query": {"type": "string"},
                    "ground_truth": {"type": "string"},
                },
                "required": ["name", "query", "ground_truth"],
                "additionalProperties": False,
            },
            # エージェントが生成した出力も評価器で利用できるようにする。
            "include_sample_schema": True,
        },
        "testing_criteria": [
            {
                # 二値評価器: 次の行動が正しければ1、それ以外は0。
                "type": "azure_ai_evaluator",
                "name": "next_action_success",
                "evaluator_name": EVALUATOR_NAME,
                "initialization_parameters": {"deployment_name": JUDGE_MODEL, "threshold": 1},
                # 質問、参照回答、回答、ツール呼び出しを渡す。ツール呼び出しにより、
                # 最適化が学習に使う判定理由で、回答が失敗した原因を説明できる。
                "data_mapping": {
                    "query": "{{item.query}}",
                    "ground_truth": "{{item.ground_truth}}",
                    "response": "{{sample.output_text}}",
                    "tool_calls": "{{sample.tool_calls}}",
                },
            },
            {
                # ルーブリック評価器: 参照回答を使わず動作を採点する。
                "type": "azure_ai_evaluator",
                "name": "purchasing_behaviour",
                "evaluator_name": RUBRIC_NAME,
                "initialization_parameters": {"model": JUDGE_MODEL},
                "data_mapping": {
                    "query": "{{item.query}}",
                    "response": "{{sample.output_text}}",
                },
            },
        ],
    }
    if project is None:
        return evaluation

    # 手順1で解決した評価器のバージョンを固定する。
    for criterion in evaluation["testing_criteria"]:
        criterion["evaluator_version"] = evaluators[criterion["evaluator_name"]]
    with project.get_openai_client() as client:
        evaluation["id"] = client.evals.create(**evaluation).id
    print(f"評価 ID: {evaluation['id']}", flush=True)
    return evaluation


def create_dataset(path: Path) -> tuple[list[dict], dict]:
    """質問と参照回答を読み込み、デプロイ済みエージェントには質問だけを渡す。"""
    # スキーマが許す項目だけを残す。最適化専用の "criteria" などは検証で失敗する。
    rows = [
        {key: row[key] for key in ("name", "query", "ground_truth")}
        for row in map(json.loads, filter(str.strip, path.read_text(encoding="utf-8").splitlines()))
    ]
    data_source = {
        "type": "azure_ai_target_completions",
        "source": {"type": "file_content", "content": [{"item": row} for row in rows]},
        "input_messages": {
            "type": "template",
            "template": [
                {
                    "type": "message",
                    "role": "user",
                    "content": {"type": "input_text", "text": "{{item.query}}"},
                }
            ],
        },
        "target": {"type": "azure_ai_agent", "name": AGENT_NAME},
    }
    return rows, data_source


def run_evaluation(project, evaluation: dict, rows: list, data_source: dict, args) -> None:
    """有料の評価実行を開始する。送信は完了ではないため、Foundry のレポートで進捗を確認する。"""
    if args.baseline:
        check_baseline(args.baseline, rows, evaluation)
    if project is None:
        print(
            json.dumps(
                {"evaluation": evaluation, "data_source": data_source}, indent=2, ensure_ascii=False
            )
        )
        return

    with project.get_openai_client() as client:
        run = client.evals.runs.create(
            eval_id=evaluation["id"], name=evaluation["name"], data_source=data_source
        )
        print(f"実行 ID: {run.id}", flush=True)
        print(f"状態: {run.status}")
        if run.report_url:
            print(f"レポート: {run.report_url}")
        print("Foundry の評価画面で進捗、回答、スコアを確認してください。")
        if args.wait:
            wait_for_evaluation(
                client,
                run.id,
                agent_name=AGENT_NAME,
                evaluation=evaluation,
                rows=rows,
                report_path=args.report,
                max_unscored=args.max_unscored,
            )


# --- 補助コード --------------------------------------------------------------


def ensure_evaluator(project: AIProjectClient, name: str, update: bool, register: bool) -> str:
    filename = f"{name}.json"
    definition = json.loads((HERE / filename).read_text())
    if definition.pop("name") != name:
        raise ValueError(f"{filename} の評価器名が {name!r} と一致しません")
    if not update:
        for evaluator in project.beta.evaluators.list(type="custom"):
            if evaluator.name == name:
                registered = project.beta.evaluators.get_version(name, evaluator.version)
                if registered.definition.as_dict() != definition["definition"]:
                    raise ValueError(
                        f"登録済み評価器 {name}:{evaluator.version} が {filename} と異なります。"
                        "--update-evaluators --register-only で変更を明示的に登録し、"
                        "影響するベースラインを再作成してください。"
                    )
                print(f"使用する評価器: {name}:{evaluator.version}", flush=True)
                return evaluator.version
        if not register:
            raise ValueError(
                f"{name} という登録済み評価器がありません。"
                "評価前に --register-only を実行してください。"
            )

    evaluator = project.beta.evaluators.create_version(name, evaluator_version=definition)
    print(f"登録した評価器: {name}:{evaluator.version}", flush=True)
    return evaluator.version


@contextmanager
def connect(dry_run: bool):
    if dry_run:
        yield None
        return
    endpoint = os.environ.get("FOUNDRY_PROJECT_ENDPOINT", "").strip()
    if not endpoint.startswith("https://"):
        raise SystemExit(
            "このターミナルの FOUNDRY_PROJECT_ENDPOINT が空、または https URL ではありません。\n"
            "sample/ から次を実行してください:\n"
            '  export FOUNDRY_PROJECT_ENDPOINT="$(azd env get-value FOUNDRY_PROJECT_ENDPOINT)"'
        )
    with (
        DefaultAzureCredential() as credential,
        AIProjectClient(endpoint=endpoint, credential=credential) as project,
    ):
        yield project


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="ホストされたデモエージェントを評価する（有料）。")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--dry-run", action="store_true", help="リクエストを表示する。クラウドを呼び出さない。"
    )
    mode.add_argument(
        "--register-only", action="store_true", help="未登録の評価器を登録する。採点は実行しない。"
    )
    parser.add_argument(
        "--update-evaluators",
        action="store_true",
        help="実行前にローカルの評価器 JSON を新しいバージョンとして登録する。",
    )
    parser.add_argument(
        "--wait", action="store_true", help="結果を待ち、実行エラーがあれば失敗する。"
    )
    parser.add_argument(
        "--report", type=Path, help="スコアの要約を JSON ファイルに書く。--wait が必要。"
    )
    parser.add_argument(
        "--baseline", type=Path, help="実行前にデータセットと評価器の互換性を確認する。"
    )
    parser.add_argument(
        "--max-unscored",
        type=int,
        default=1,
        help="実行を失敗させずに各評価器で許容する未採点の質問数（レート制限エラーなど）。"
        "その質問は平均から除外する。全件の採点が必要な場合は0にする。",
    )
    args = parser.parse_args()
    if not AGENT_NAME.strip():
        parser.error("AGENT_NAME は空にできません")
    if args.wait and (args.dry_run or args.register_only):
        parser.error("--wait には評価の実行が必要です")
    if args.report and not args.wait:
        parser.error("--report には --wait が必要です")
    if args.max_unscored < 0:
        parser.error("--max-unscored は0以上にしてください")
    return args


if __name__ == "__main__":
    main()
