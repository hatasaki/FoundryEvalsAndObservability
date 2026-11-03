"""候補設定がプロンプトやツール説明にコピーした業務上の事実を検出する。

最適化は、ポリシーの事実（金額、承認者、日付、人名）を instructions.md や tools.json に
書き込んでスコアを上げる場合がある。コピーした事実はポリシー変更で古くなる。
この検査は、ベースラインにない事実を候補が追加すると失敗する。

使用例（sample/ から）:
    python evaluation/check_prompt_facts.py \
        --baseline agent/.agent_configs/baseline \
        --candidate path/to/candidate_config \
        --data agent/data/*.json

終了コード1は新しい事実の検出を示す。意図的に大まかな検査であり、人が一覧を確認して
候補を採用するか却下するかを判断する。
"""

import argparse
import json
import re
import sys
from pathlib import Path

GENERIC_FACTS = {
    "amount": re.compile(r"\$\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?|\$\s?\d+(?:\.\d+)?"),
    "duration": re.compile(
        r"\b\d+\s*(?:calendar\s+)?(?:hours?|days?|months?|years?)\b"
        r"|\d+\s*(?:暦日|時間|日間|日|か月|カ月|ヶ月|年間|年)",
        re.I,
    ),
    "date": re.compile(
        r"\b(?:\d{4}-\d{2}-\d{2}|(?:January|February|March|April|May|June|July|August|"
        r"September|October|November|December)\s+\d{1,2}|\d{1,2}\s+(?:January|February|"
        r"March|April|May|June|July|August|September|October|November|December))\b"
        r"|(?:\d{4}年)?\d{1,2}月\d{1,2}日",
        re.I,
    ),
    "source_id": re.compile(
        r"(?<![a-z0-9-])(?:policy|notice|people|register|message):[a-z0-9-]+(?![a-z0-9-])"
    ),
}

# 英語の役職名や CamelCase の名称をコーパスから取得する。
NAME_PHRASE = re.compile(
    r"\b[A-Z][a-z]+(?:\s+(?:of\s+)?[A-Z][a-zA-Z]+)+\b|\b[A-Z][a-z]+[A-Z][a-zA-Z]+\b"
)
STOP_PHRASES = {"Sources", "Return JSON", "From", "Note"}


def read_config_text(directory: Path) -> str:
    parts = []
    instructions = directory / "instructions.md"
    if instructions.is_file():
        parts.append(instructions.read_text(encoding="utf-8"))
    tools = directory / "tools.json"
    if tools.is_file():
        for tool in json.loads(tools.read_text(encoding="utf-8")):
            function = tool.get("function", tool)
            parts.append(function.get("description", ""))
            for prop in function.get("parameters", {}).get("properties", {}).values():
                parts.append(prop.get("description", ""))
    return "\n".join(parts)


def corpus_names(paths: list[Path]) -> set[str]:
    names = set()
    for path in paths:
        documents = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(documents, list):  # policy_embeddings.json などは本文でなくベクトル
            continue
        for document in documents:
            text = f"{document.get('title', '')}. {document.get('content', '')}"
            names.update(re.findall(r"役職名簿:.*? は (.+?) です", text))
            for match in NAME_PHRASE.findall(text):
                if match not in STOP_PHRASES and not match.startswith(
                    ("The ", "This ", "For ", "An ", "A ")
                ):
                    names.add(match)
    return names


def find_facts(text: str, names: set[str]) -> set[tuple[str, str]]:
    found = set()
    for kind, pattern in GENERIC_FACTS.items():
        for match in pattern.findall(text):
            found.add((kind, " ".join(match.split())))
    lowered = text.lower()
    for name in names:
        if (
            not name.isascii()
            and name.lower() in lowered
            or re.search(r"\b" + re.escape(name.lower()) + r"\b", lowered)
        ):
            found.add(("name", name))
    return found


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument(
        "--data", type=Path, nargs="+", required=True, help="ポリシー・通知・人員の JSON ファイル"
    )
    args = parser.parse_args()

    names = corpus_names(args.data)
    baseline = find_facts(read_config_text(args.baseline), names)
    candidate = find_facts(read_config_text(args.candidate), names)
    new_facts = sorted(candidate - baseline)

    if not new_facts:
        print("OK: 候補はベースラインにない業務上の事実を追加していません。")
        return 0
    print(f"FAIL: 候補がベースラインにない業務上の事実を {len(new_facts)} 件追加しています:")
    for kind, value in new_facts:
        print(f"  [{kind}] {value}")
    print("これらはプロンプトではなく知識ソースに置く内容です。昇格前に確認してください。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
