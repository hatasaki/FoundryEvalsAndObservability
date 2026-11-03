"""knowledge_base_retrieve のハイブリッド検索用にポリシーの埋め込みを生成する。

agent/data/policies.json の変更後、sample/ から実行する（FOUNDRY_PROJECT_ENDPOINT が必要）:
    python agent/build_embeddings.py
保存済み埋め込みとポリシーの一致を、ネットワークに接続せず確認する（CI でも使用）:
    python agent/build_embeddings.py --check
"""

import argparse
import json
import sys

import tools


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="埋め込みが古い場合は失敗する。")
    args = parser.parse_args()
    policies = tools.read_documents("policies.json")

    if args.check:
        stored = json.loads(tools.EMBEDDINGS.read_text()) if tools.EMBEDDINGS.is_file() else {}
        stale = tools.stale_policies(policies, stored)
        if stale:
            sys.exit(
                f"{stale} の埋め込みが古いか、存在しません。\n"
                "実行: python agent/build_embeddings.py"
            )
        print(f"全{len(policies)}件のポリシーと埋め込みが一致しています。")
        return

    vectors = tools.embed([tools.policy_text(p) for p in policies])
    stored = {
        "model": tools.EMBEDDING_DEPLOYMENT,
        "dimensions": tools.EMBEDDING_DIMENSIONS,
        "policies": {
            p["id"]: {"hash": tools.policy_hash(p), "vector": [round(x, 6) for x in v]}
            for p, v in zip(policies, vectors, strict=True)
        },
    }
    tools.EMBEDDINGS.write_text(json.dumps(stored, separators=(",", ":")) + "\n")
    print(f"{tools.EMBEDDINGS.name} を書き込みました（ポリシー{len(policies)}件）。")


if __name__ == "__main__":
    main()
