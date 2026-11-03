#!/bin/sh
# purchasing-advice-demo の postdeploy フック（azure.yaml 参照）。
# ホストされたエージェントは、azd deploy が作る自身の ID で埋め込みを呼び出すため、
# Bicep では権限を付けられない。アカウントに Cognitive Services OpenAI User（モデル推論のみ）を付ける。
# 再実行しても安全。この処理でデプロイを失敗させない。権限がなければポリシー検索は
# キーワードにフォールバックし、トレースの fallback_reason に理由が出る。
set -u
SERVICE="purchasing-advice-demo"
ROLE="5e0bd9bd-7b93-4f28-af87-19fc36ad61bd" # Cognitive Services OpenAI User

warn() {
  echo "警告: $1 ポリシー検索はキーワードにフォールバックします。" >&2
  exit 0
}

# azd は key not found を標準出力に書くため、成功時だけ出力を使う。
PROJECT_ID="${AZURE_AI_PROJECT_ID:-$(azd env get-value AZURE_AI_PROJECT_ID 2>/dev/null || true)}"
case "$PROJECT_ID" in /subscriptions/*) ;; *) PROJECT_ID="" ;; esac
[ -n "$PROJECT_ID" ] || warn "AZURE_AI_PROJECT_ID が未設定です。"

PRINCIPAL="$(azd ai agent show "$SERVICE" --output json 2>/dev/null | python3 -c \
  'import json, sys; print(json.load(sys.stdin)["instance_identity"]["principal_id"])' \
  2>/dev/null)"
[ -n "$PRINCIPAL" ] || warn "azd ai agent show からエージェントの ID を取得できませんでした。"

if az role assignment create --assignee-object-id "$PRINCIPAL" \
  --assignee-principal-type ServicePrincipal --role "$ROLE" \
  --scope "${PROJECT_ID%/projects/*}" --output none; then
  echo "エージェント ID $PRINCIPAL にアカウントの Cognitive Services OpenAI User を付けました（反映には数分かかります）。"
else
  warn "$PRINCIPAL への埋め込み用ロールの付与に失敗しました。"
fi
