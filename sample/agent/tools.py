import hashlib
import json
import logging
import math
import os
import re
import sqlite3
from functools import cache
from pathlib import Path
from urllib.parse import urlsplit

DATA = Path(__file__).parent / "data"
EMBEDDINGS = DATA / "policy_embeddings.json"
EMBEDDING_DEPLOYMENT = os.environ.get("EMBEDDING_DEPLOYMENT", "text-embedding-3-small")
EMBEDDING_DIMENSIONS = 512
POLICY_RESULTS = 5
RRF_K = 60  # Azure AI Search のハイブリッド検索でも使われる逆順位融合の定数
STOP_WORDS = set("a an and are can for from i in is it of on or our the to we with".split())

log = logging.getLogger(__name__)


def read_documents(filename: str) -> list[dict]:
    return json.loads((DATA / filename).read_text(encoding="utf-8"))


def _search_terms(text: str) -> list[str]:
    tokens = re.findall(r"[a-z0-9]+|[\u3040-\u30ff\u3400-\u9fff]+", text.lower())
    terms = []
    for token in tokens:
        if re.fullmatch(r"[a-z0-9]+", token):
            terms.append(token)
        else:
            terms.extend(token[index : index + 2] for index in range(max(1, len(token) - 1)))
    return terms


def _keyword_ranking(filename: str, query: str, limit: int | None = 3) -> list[str]:
    """タイトルと本文を BM25 で検索し、関連度の高い順に文書 ID を返す。"""
    terms = sorted(set(_search_terms(query)) - STOP_WORDS)
    if not terms:
        raise ValueError("取引先、製品、ポリシーの話題など、検索できる語句を指定してください。")
    documents = read_documents(filename)
    with sqlite3.connect(":memory:") as connection:
        connection.execute(
            "CREATE VIRTUAL TABLE documents USING fts5("
            "id UNINDEXED, title, content, tokenize='porter unicode61')"
        )
        connection.executemany(
            "INSERT INTO documents (id, title, content) VALUES (?, ?, ?)",
            [
                (
                    document["id"],
                    " ".join(_search_terms(document["title"])),
                    " ".join(_search_terms(document["content"])),
                )
                for document in documents
            ],
        )
        # 検索語のいずれかに一致する文書を検索し、本文よりタイトルの一致を重く扱う。
        sql = (
            "SELECT id FROM documents WHERE documents MATCH ? ORDER BY bm25(documents, 0, 3, 1), id"
        )
        params: tuple = (" OR ".join(f'"{term}"' for term in terms),)
        if limit is not None:
            sql += " LIMIT ?"
            params += (limit,)
        return [row[0] for row in connection.execute(sql, params).fetchall()]


def _search(filename: str, query: str) -> list[dict]:
    by_id = {document["id"]: document for document in read_documents(filename)}
    return [by_id[doc_id] for doc_id in _keyword_ranking(filename, query)]


# ポリシーの埋め込みは build_embeddings.py で事前生成し、policies.json との整合性を確認する。


def policy_text(policy: dict) -> str:
    return f"{policy['title']}\n\n{policy['content']}"


def policy_hash(policy: dict) -> str:
    return hashlib.sha256(policy_text(policy).encode("utf-8")).hexdigest()[:16]


# Microsoft の案内に従い、アカウントの cognitiveservices.azure.com ホストにある OpenAI v1
# エンドポイントで埋め込みを取得する。確認済み: プロジェクト経由の埋め込みは 404、
# services.ai.azure.com ホストではロールがあってもホストされたエージェントの ID は 401 になる。
# エージェントの ID にはアカウントの Cognitive Services OpenAI User が必要で、
# infra/grant-agent-embeddings.sh がデプロイごとに付与する。
EMBEDDING_SCOPE = "https://cognitiveservices.azure.com/.default"


def openai_endpoint() -> str:
    if explicit := os.environ.get("AZURE_OPENAI_ENDPOINT"):
        return explicit.rstrip("/") + "/openai/v1/"
    host = urlsplit(
        os.environ["FOUNDRY_PROJECT_ENDPOINT"]
    ).netloc  # <account>.services.ai.azure.com
    account = host.split(".")[0]
    return f"https://{account}.cognitiveservices.azure.com/openai/v1/"


@cache
def _openai_client():
    from azure.identity import DefaultAzureCredential, get_bearer_token_provider
    from openai import OpenAI

    token = get_bearer_token_provider(DefaultAzureCredential(), EMBEDDING_SCOPE)
    return OpenAI(base_url=openai_endpoint(), api_key=token)


def embed(texts: list[str]) -> list[list[float]]:
    response = _openai_client().embeddings.create(
        model=EMBEDDING_DEPLOYMENT, input=texts, dimensions=EMBEDDING_DIMENSIONS
    )
    return [item.embedding for item in response.data]


def _caller_identity() -> str:
    """401 の診断用に、トークンのクレームから呼び出し元 ID を読み取る。"""
    try:
        import base64

        from azure.identity import DefaultAzureCredential

        token = DefaultAzureCredential().get_token(EMBEDDING_SCOPE)
        payload = token.token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return f"oid={claims.get('oid')} appid={claims.get('appid') or claims.get('azp')}"
    except Exception as error:
        return f"不明（{type(error).__name__}）"


def stale_policies(policies: list[dict], stored: dict) -> list[str]:
    vectors = stored.get("policies", {})
    return [p["id"] for p in policies if vectors.get(p["id"], {}).get("hash") != policy_hash(p)]


@cache
def _policy_vectors() -> dict[str, list[float]] | None:
    if not EMBEDDINGS.is_file():
        log.warning("%s がないため、ポリシー検索はキーワード検索のみです。", EMBEDDINGS.name)
        return None
    stored = json.loads(EMBEDDINGS.read_text(encoding="utf-8"))
    stale = stale_policies(read_documents("policies.json"), stored)
    if stale:
        log.warning("%s の埋め込みが古いため、ポリシー検索はキーワード検索のみです。", stale)
        return None
    return {doc_id: entry["vector"] for doc_id, entry in stored["policies"].items()}


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    return dot / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)))


def _fuse(*rankings: list[str]) -> list[str]:
    """逆順位融合により、どちらかの検索方法で上位になった文書を優先する。"""
    scores: dict[str, float] = {}
    for ranking in rankings:
        for rank, doc_id in enumerate(ranking, start=1):
            scores[doc_id] = scores.get(doc_id, 0.0) + 1 / (RRF_K + rank)
    return sorted(scores, key=lambda doc_id: (-scores[doc_id], doc_id))


# 以下の3ツールは Microsoft IQ の MCP ツールの形を模倣する。
# 実際の IQ は LLM を利用するが、ここではローカルデータを使う決定的な代替実装である。


def knowledge_base_retrieve(queries: list[str]) -> str:
    """Foundry IQ の模擬ナレッジベース。

    ポリシーをキーワードとベクトルのハイブリッド検索で取得する。
    """
    policies = {p["id"]: p for p in read_documents("policies.json")}
    vectors = _policy_vectors()
    query_vectors = None
    fallback = "埋め込みが存在しないか、古くなっています"
    if vectors is not None:
        try:
            query_vectors = embed(queries)
        except Exception as error:  # 会話を失敗させず、キーワード検索に切り替える
            log.warning("検索語の埋め込みに失敗したため、キーワード検索のみです。", exc_info=True)
            fallback = f"埋め込み呼び出しに失敗: {type(error).__name__}: {str(error)[:300]}"
            if "PermissionDenied" in str(error):
                fallback += f" 呼び出し元: {_caller_identity()}"
    references = {}
    for i, query in enumerate(queries):
        keyword = _keyword_ranking("policies.json", query, limit=None)
        if query_vectors is None:
            ranked = keyword
        else:
            similarity = {doc_id: _cosine(query_vectors[i], v) for doc_id, v in vectors.items()}
            semantic = sorted(similarity, key=lambda doc_id: -similarity[doc_id])
            ranked = _fuse(keyword, semantic)
        for doc_id in ranked[:POLICY_RESULTS]:
            references.setdefault(doc_id, policies[doc_id])
    result = {"queries": queries, "search_mode": "hybrid"}
    if query_vectors is None:
        result |= {"search_mode": "keyword", "fallback_reason": fallback}
    return json.dumps(result | {"references": list(references.values())}, ensure_ascii=False)


LINE_MANAGER = re.compile(r"直属上司: ([^。]+)。")
ROLE_HOLDER = re.compile(r"役職名簿: ([^。]+?) は ([^。]+) です。")
ABOUT_AUTHORITY = re.compile(r"委任|承認|代行|代理|決裁|delegat|approv|cover|sign", re.IGNORECASE)


def _holder_records(name: str, question: str) -> list[dict]:
    """本人の名簿レコードと、質問に応じて記録された委任を返す。"""
    records = []
    for document in read_documents("people.json") + read_documents("roster.json"):
        content = document["content"]
        if content.startswith((f"名簿: {name} は", f"役職名簿: {name} は")):
            records.append(document)
        elif ABOUT_AUTHORITY.search(question) and re.match(
            rf"記録者: {re.escape(name)}[。、]", content
        ):
            records.append(document)
    return records


def _resolve_people(results: list[dict], question: str) -> list[dict]:
    """実際の Work IQ と同様に「私の直属上司」や「接待責任者」を解決し、
    一つの質問で本人の勤務状況と委任の記録まで取得する。"""
    names = [m.group(1) for r in results if (m := LINE_MANAGER.search(r["content"]))]
    for document in read_documents("people.json"):
        match = ROLE_HOLDER.match(document["content"])
        if match and match.group(2).lower() in question.lower():
            names.append(match.group(1))
    return [record for name in dict.fromkeys(names) for record in _holder_records(name, question)]


def ask(question: str) -> str:
    """Work IQ の模擬実装。人、役職、勤務状況、メッセージ、通知、許可を検索する。"""
    results = (
        _search("notices.json", question)
        + _search("people.json", question)
        + _search("roster.json", question)
    )
    results += _resolve_people(results, question)
    unique = list({r["id"]: r for r in results}.values())
    return json.dumps({"question": question, "results": unique}, ensure_ascii=False)


def search_ontology(question: str) -> str:
    """Fabric IQ の模擬オントロジー。部門予算などの業務エンティティを扱う。"""
    result = {
        "id": "ontology:department-budget",
        "entity": "Department",
        "available_budget": 50000,
        "currency": "dollars",
    }
    return json.dumps({"question": question, "results": [result]}, ensure_ascii=False)
