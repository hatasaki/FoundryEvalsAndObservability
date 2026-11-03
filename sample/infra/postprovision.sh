#!/bin/sh
# postprovision フック（azure.yaml 参照）。main.bicep で作った GitHub Actions の ID を GitHub に設定する。
# GitHub CLI にログイン済みなら GITHUB_REPOSITORY に demo 環境を作り、7つの変数を設定する。
# この処理の失敗でプロビジョニングを失敗させない。
# 単独で再実行（gh auth login の後など）: azd hooks run postprovision
set -u
# azd は key not found を標準出力に書くため、成功時だけ出力を使う。
v() { out="$(azd env get-value "$1" 2>/dev/null)" && printf '%s' "$out"; }
REPO="$(v GITHUB_REPOSITORY)"
CLIENT_ID="$(v githubClientId)"  # camelCase: main.bicep の出力を参照
if [ -z "$REPO" ] || [ -z "$CLIENT_ID" ]; then
  echo "警告: GITHUB_REPOSITORY または githubClientId がありません。main.bicep をプロビジョニングしましたか。" >&2
  exit 0
fi
if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
  echo "警告: GitHub CLI が未ログインです。gh auth login の後に azd hooks run postprovision を実行してください。" >&2
  exit 0
fi
if ! gh api -X PUT "repos/$REPO/environments/demo" --silent; then
  echo "警告: $REPO に demo 環境を作成できませんでした。管理者権限を確認してください。" >&2
  exit 0
fi
set_var() { gh variable set "$1" --env demo --repo "$REPO" --body "$2"; }
set_var AZURE_CLIENT_ID "$CLIENT_ID"
set_var AZURE_TENANT_ID "$(v githubTenantId)"
for key in AZURE_SUBSCRIPTION_ID AZURE_ENV_NAME AZURE_LOCATION AZURE_AI_PROJECT_ID \
  FOUNDRY_PROJECT_ENDPOINT; do
  set_var "$key" "$(v "$key")"
done
echo "$REPO の GitHub 環境 demo に7つの変数を設定しました（ID: $CLIENT_ID）。"

# production: リリースワークフローの承認ステップ。Azure にはログインせず、
# 必須レビュー担当者の承認を待つ。ここでは gh にログイン中のユーザーを指定する。
ME="$(gh api user --jq .id 2>/dev/null || true)"
if [ -n "$ME" ] && printf '{"reviewers":[{"type":"User","id":%s}]}' "$ME" \
  | gh api -X PUT "repos/$REPO/environments/production" --input - --silent; then
  echo "$REPO の GitHub 環境 production では、リリースに本人の承認が必要です。"
else
  echo "警告: 本人をレビュー担当者とする production を作れませんでした（必須レビューには公開リポジトリまたは有料プランが必要）。リポジトリの Settings > Environments で作成してください。" >&2
fi
