#!/bin/sh
# preprovision フック（azure.yaml 参照）。
# 1. main.bicep が必要とする githubRepository は GITHUB_REPOSITORY に対応する。未設定なら
#    クローンの origin を候補として一度だけ尋ねて保存し、次回以降のプロビジョニングで再利用する。
# 2. GitHub の OIDC トークンの subject には所有者とリポジトリの ID が含まれる
#    （repo:owner@123/name@456:environment:demo）。GitHub CLI にログイン済みなら ID を調べ、
#    正確な subject を GITHUB_OIDC_SUBJECT に保存して、GitHub が送る値を信頼できるようにする。
# 3. ユーザーのオブジェクト ID を AZURE_PRINCIPAL_ID に保存し、main.bicep がアカウントレベルの
#    Foundry User を付与できるようにする。評価は本人の ID で評価モデルを呼び出す。
set -eu
# azd は key not found を標準出力に書くため、成功時だけ出力を使う。
v() { out="$(azd env get-value "$1" 2>/dev/null)" && printf '%s' "$out"; }

REPO="$(v GITHUB_REPOSITORY || true)"
if [ -z "$REPO" ]; then
  SUGGESTED="$(git remote get-url origin 2>/dev/null \
    | sed -E 's#^(https://github.com/|git@github.com:)##; s#\.git$##' || true)"
  if (exec </dev/tty >/dev/tty) 2>/dev/null; then  # 実際に開けるターミナル
    printf 'CI/CD 用の GitHub リポジトリ（owner/name）[%s]: ' "$SUGGESTED" > /dev/tty
    read -r REPO < /dev/tty || REPO=""
  fi
  REPO="${REPO:-$SUGGESTED}"
  if [ -z "$REPO" ]; then
    echo "エラー: 先に GitHub リポジトリを設定してください: azd env set GITHUB_REPOSITORY <owner>/<name>" >&2
    exit 1
  fi
  azd env set GITHUB_REPOSITORY "$REPO"
  echo "GITHUB_REPOSITORY=$REPO を保存しました。"
fi

if command -v gh >/dev/null 2>&1 && IDS="$(gh api "repos/$REPO" --jq '"\(.owner.login)@\(.owner.id)/\(.name)@\(.id)"' 2>/dev/null)"; then
  SUBJECT="repo:$IDS:environment:demo"
  if [ "$(v GITHUB_OIDC_SUBJECT || true)" != "$SUBJECT" ]; then
    azd env set GITHUB_OIDC_SUBJECT "$SUBJECT"
    echo "GITHUB_OIDC_SUBJECT=$SUBJECT を保存しました。"
  fi
else
  echo "警告: GitHub CLI で $REPO を取得できませんでした。ID は従来形式の subject repo:$REPO:environment:demo を信頼します。" >&2
fi

if ME="$(az ad signed-in-user show --query id -o tsv 2>/dev/null)" && [ -n "$ME" ]; then
  if [ "$(v AZURE_PRINCIPAL_ID || true)" != "$ME" ]; then
    azd env set AZURE_PRINCIPAL_ID "$ME"
    echo "AZURE_PRINCIPAL_ID=$ME を保存しました（本人が評価を実行）。"
  fi
else
  echo "警告: az ad signed-in-user show でユーザーを取得できませんでした。az login を実行してください。ログインしないと評価モデルを呼び出せません。" >&2
fi
