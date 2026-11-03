# 画面に表示するデモ用コマンド。1つずつコピーして実行する。
# 仮想環境を有効にし、FOUNDRY_PROJECT_ENDPOINT を設定して sample/ から実行する。
# 有料 = モデル呼び出しやデプロイ。時間がかかるものは発表前に実行する。
echo "このファイルからコマンドを1つずつ実行してください。スクリプトとして実行しないでください。" && exit 1

# --- アプリのみをデプロイ ---
azd deploy purchasing-advice-demo

# --- デモ2: 初期エージェントの実行（ライブ） ---
azd ai agent invoke purchasing-advice-demo --new-session --new-conversation \
  '判断日は2026年10月13日です。今週木曜日に6人でチームの夕食会を予約できますか。約$540で、直属上司は承認済みです。'

azd ai agent invoke purchasing-advice-demo 'はい、ワインも出ます。'   # 同じセッション

azd ai agent invoke purchasing-advice-demo --new-session --new-conversation \
  '判断日は2026年10月21日です。Engineering 部門の Marcus Webb です。役員会議室のビデオ会議システムを$6,800で購入できますか。取引先の見積書を2件取得済みです。'

# --- デモ4: 評価（有料、約10分） ---
python evaluation/evaluate.py --dry-run                          # リクエストの表示のみ
EVAL_DATASET=evaluation/datasets/approvers-holdout.jsonl python evaluation/evaluate.py --wait

# 実行を質問ごとに比較する
python evaluation/compare_runs.py --list
python evaluation/compare_runs.py --a OLD_RUN_1 OLD_RUN_2 --b NEW_RUN_1 NEW_RUN_2

# --- デモ5: 最適化（有料、約1時間） ---
azd ai agent optimize --config evaluation/optimize.yaml --no-prompt

# --- デモ6: 候補の事実コピー検査（Azure 不要） ---
python evaluation/check_prompt_facts.py --baseline agent/.agent_configs/baseline \
  --candidate evaluation/candidates/optimiser-0.691 --data agent/data/*.json

# --- CI/CD: ワークフローの手動実行（有料） ---
gh workflow run agent-main.yml --ref BRANCH -f mode=holdout     # PR ブランチの検査。リリースしない
gh workflow run agent-main.yml --ref jp -f mode=release         # 承認を経て jp を昇格

# === 舞台では表示しない準備 ===

# 保存済み候補から PR を作る（ブランチ、フォルダー、タイトル、本文）
open_pr() {
  git switch jp && git pull --ff-only && git switch -c "$1" || return
  cp "evaluation/candidates/$2/"{instructions.md,metadata.yaml,tools.json} \
    agent/.agent_configs/baseline/ || return
  git add agent/.agent_configs/baseline || return
  git commit -m "$3" && git push -u origin "$1" \
    && gh pr create --base jp --title "$3" --body "$4"
}
open_pr demo/reviewed-candidate reviewed "証拠に基づく購入助言の改善をレビュー" \
  "手動で改善して保存した設定です。最適化が生成した採用候補ではありません。"
open_pr demo/no-grounding regressed "デモ: ツールを使わず、すべての質問に同じ回答" \
  "意図的に悪くした対照例です。評価の失敗を確認し、マージしないでください。"
git switch jp

# 変更した評価器を登録する（その後、影響するベースラインを更新する）
python evaluation/evaluate.py --update-evaluators --register-only

# リリースせずにドリフトのベースラインを作る（有料）
gh workflow run agent-main.yml --ref jp -f mode=baseline-drift

# 名簿とテストセット、またはポリシーの埋め込みを再生成する
python evaluation/generate_approver_data.py
python agent/build_embeddings.py          # --check は Azure を使わず整合性を確認する
