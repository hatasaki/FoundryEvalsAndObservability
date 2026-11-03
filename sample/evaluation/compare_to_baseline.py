"""評価レポートを保存済みベースラインと比較してゲート判定する。

次の場合は失敗する（終了コード1）:
    * いずれかの評価器の平均が、ベースラインから --tolerance を超えて下がった。
    * --must-pass で指定した評価器に失敗ケースがある。
    * --min-passed で指定した評価器が合格件数の下限を満たさない、または未採点がある。

--min-passed の評価器は平均差ではなく合格件数で判定する。

両ファイルは `evaluation/evaluate.py --wait --report` が書く JSON を使う。

使用例（sample/ から）:
        # jp の正常と確認できた実行から、一度だけ作成する:
    python evaluation/compare_to_baseline.py --report report.json \
        --baseline evaluation/baselines/approvers-drift.json --write-baseline

    # CI では各リリースの前に実行する（PR ではドリフトセットを実行しない）:
    python evaluation/compare_to_baseline.py --report report.json \
        --baseline evaluation/baselines/approvers-drift.json \
        --tolerance 0.03 --min-passed next_action_success=6
"""

import argparse
import json
import shutil
import sys
from pathlib import Path


def by_name(report: dict) -> dict[str, dict]:
    if not report.get("results_complete"):
        raise SystemExit("レポートが不完全です。評価が正常に完了していません。")
    return {criterion["name"]: criterion for criterion in report["criteria"]}


def provenance_errors(report: dict, baseline: dict) -> list[str]:
    for label, data in (("レポート", report), ("ベースライン", baseline)):
        provenance = data.get("provenance") or {}
        if not provenance.get("dataset_sha256") or not provenance.get("judges"):
            return [
                f"{label}にデータセットと評価器の来歴がありません。正常と確認できたバージョンを"
                "write_baseline=true で実行し、新しいベースライン成果物をコミットしてください。"
            ]
    errors = []
    if report["provenance"]["dataset_sha256"] != baseline["provenance"]["dataset_sha256"]:
        errors.append(
            "データセットがベースラインと異なります。ベースラインを明示的に再作成してください。"
        )
    if report["provenance"]["judges"] != baseline["provenance"]["judges"]:
        errors.append(
            "評価器の定義または採点設定がベースラインと異なります。ベースラインを明示的に再作成してください。"
        )
    return errors


def minimum_passed(value: str) -> tuple[str, int]:
    try:
        name, count = value.rsplit("=", 1)
        minimum = int(count)
    except ValueError as error:
        raise argparse.ArgumentTypeError("評価器名=正の整数 で指定してください") from error
    if not name.strip() or minimum < 1:
        raise argparse.ArgumentTypeError("評価器名=正の整数 で指定してください")
    return name, minimum


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument(
        "--tolerance",
        type=float,
        default=0.03,
        help="許容する平均スコアの低下。Foundry は0.03未満の変動をノイズとして扱う。",
    )
    parser.add_argument(
        "--must-pass",
        nargs="*",
        default=[],
        help="1件でも失敗すると変更を阻止する評価器。",
    )
    parser.add_argument(
        "--min-passed",
        type=minimum_passed,
        metavar="EVALUATOR=COUNT",
        help="平均差の代わりに合格件数の下限と未採点0を要求する評価器。",
    )
    parser.add_argument(
        "--write-baseline",
        action="store_true",
        help="比較せず、このレポートを新しいベースラインとして保存する。",
    )
    args = parser.parse_args()
    minimum_name, minimum_count = args.min_passed or (None, 0)
    if minimum_name in args.must_pass:
        parser.error("同じ評価器に --must-pass と --min-passed は併用できません")

    report = json.loads(args.report.read_text())
    current = by_name(report)
    failures = []
    for name in args.must_pass:
        if name not in current:
            failures.append(f"{name}: 必須合格の評価器がありません")
        elif current[name]["failed"] > 0 or current[name].get("unscored", 0) > 0:
            failures.append(
                f"{name}: 必須合格のケースが {current[name]['failed']} 件失敗し、"
                f"{current[name].get('unscored', 0)} 件が未採点でした"
            )
    if minimum_name is not None:
        print(f"{minimum_name}: 平均差ではなく合格{minimum_count}件以上・未採点0で判定します。")
        if minimum_name not in current:
            failures.append(f"{minimum_name}: 合格件数を確認する評価器がありません")
        else:
            criterion = current[minimum_name]
            counts = [criterion.get(key) for key in ("passed", "failed", "total", "unscored")]
            if (
                any(type(count) is not int or count < 0 for count in counts)
                or criterion["passed"] + criterion["failed"] != criterion["total"]
                or criterion["total"] != report.get("result_counts", {}).get("total")
            ):
                failures.append(f"{minimum_name}: 合否件数が不正、または全件の採点が未完了です")
            elif criterion["passed"] < minimum_count or criterion["unscored"] > 0:
                failures.append(
                    f"{minimum_name}: {criterion['passed']}/{criterion['total']} 件合格、"
                    f"{criterion['unscored']} 件未採点"
                    f"（合格{minimum_count}件以上・未採点0が必要）"
                )

    if args.write_baseline:
        failures.extend(provenance_errors(report, report))
        if failures:
            print("FAIL: " + "\n".join(failures))
            return 1
        args.baseline.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(args.report, args.baseline)
        print(f"ベースラインを {args.baseline} に書き込みました")
        return 0

    if not args.baseline.is_file():
        print(
            f"FAIL: {args.baseline} にベースラインがありません。"
            "正常と確認できたバージョンを一度 --write-baseline で実行してください。"
        )
        return 1
    baseline_report = json.loads(args.baseline.read_text())
    baseline = by_name(baseline_report)

    failures.extend(provenance_errors(report, baseline_report))
    if set(current) != set(baseline):
        failures.append("評価器名がベースラインと異なります。")
    print(f"{'評価器':<28}{'ベースライン':>10}{'今回':>10}{'差分':>10}  失敗件数")
    for name, base in sorted(baseline.items()):
        if name not in current:
            failures.append(f"{name}: 今回の実行にありません")
            continue
        now = current[name]
        change = now["mean_score"] - base["mean_score"]
        print(
            f"{name:<28}{base['mean_score']:>10.3f}{now['mean_score']:>10.3f}{change:>+10.3f}  "
            f"{now['failed']}/{now['total']}"
        )
        if name == minimum_name and now["total"] != base["total"] + base.get("unscored", 0):
            failures.append(f"{name}: 採点件数がベースラインの質問総数と異なります")
        if name != minimum_name and change < -args.tolerance:
            failures.append(
                f"{name}: 平均が {-change:.3f} 下がり、ノイズ幅 {args.tolerance} を超えました"
            )

    if failures:
        print("\nFAIL:")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("\nOK: ノイズ幅を超える低下も、必須合格ケースの失敗もありません。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
