# プロンプトから本番へ: 発表者向け運用ガイド

Microsoft Foundry の購入助言エージェントを、最初のプロンプトからゲート付きリリースまで進める。
スライドは `presentation/deck.html`（または `presentation.pptx`）。
登壇中に使うコマンドはすべて `sample/demo-commands.sh` にある。

## エージェント

`purchasing-advice-demo`: Microsoft Agent Framework と GPT-5.4-mini（低い推論設定）を使用し、
Foundry でホストする。**助言のみ**であり、承認、購入、誰かへの連絡はできない。
ツールは Microsoft IQ を模したローカルの代替実装であり、実際の IQ には接続しない。

| ツール | 模しているサービス | 回答する内容 |
| --- | --- | --- |
| `knowledge_base_retrieve` | Foundry IQ | ポリシー（キーワードと埋め込みのハイブリッド検索） |
| `ask` | Work IQ | 役職、休暇、記録済み委任、メッセージ |
| `search_ontology` | Fabric IQ | 部門の予算 |

## ファイルの場所

| パス | 内容 |
| --- | --- |
| `sample/agent/` | エージェントのコード、ツール、ベースライン設定（`.agent_configs/baseline/`）、データ |
| `sample/evaluation/` | 評価・比較スクリプト、評価器、`optimize.yaml`、ベースライン |
| `sample/evaluation/datasets/` | `generate_approver_data.py` で生成する3つのテストセット |
| `sample/evaluation/candidates/` | 保存済み設定: 手動改善の `reviewed/`、意図的に悪い `regressed/`、過去の最適化例 `optimiser-0.691/` |
| `sample/infra/` | Foundry テンプレート、監視モジュール、azd フック |
| `.github/workflows/` | jp への PR ゲートと jp からリリースへの昇格 |
| `presentation/rehearsal/` | HTML スライド用の任意のリハーサルコーチ |

| テストセット | 質問数 | 用途 |
| --- | --- | --- |
| 開発 | 34 | 最適化の学習、PR ゲート |
| ホールドアウト | 22 | 最適化の検証（候補選択に影響する）、jp へのマージ |
| ドリフト | 8 | リリースゲートのみ。最適化には絶対に渡さない |

## 初回セットアップ

Python 3.13、`uv`、Azure CLI、azd 1.35 以上、GitHub CLI が必要。
リソース作成とロール割り当てが可能なサブスクリプション、および Australia East の
GPT-5.4-mini（400）、GPT-5.5（300）、text-embedding-3-small（50）のクォータを用意する。
共同発表者は、Actions を有効にした自分のフォークを使う。

`sample/` から実行する（15〜20分を見込む）:

```bash
az login && azd auth login && gh auth login      # azd up の前に gh へのログインが必要
azd extension install azure.ai.agents --version 1.0.0-beta.13
azd extension install azure.ai.projects --version 1.0.0-beta.8
azd extension install azure.ai.connections --version 1.0.0-beta.9
uv venv --python 3.13 && source .venv/bin/activate
uv pip install --require-hashes -r agent/requirements.txt -r requirements-dev.txt

azd env new my-demo --location australiaeast
azd up                                           # クローンの origin をリポジトリとして選ぶ
export FOUNDRY_PROJECT_ENDPOINT="$(azd env get-value FOUNDRY_PROJECT_ENDPOINT)"
python evaluation/evaluate.py --register-only    # 評価器の登録のみ。採点しない
```

`azd up` は Foundry プロジェクト、モデル、Application Insights、エージェント、
GitHub Actions の ID、GitHub 環境 `demo`（Azure 変数）と `production`（自分がレビュー担当）を作る。
デモ2の質問で確認し、トレースのポリシー検索に `"search_mode": "hybrid"` が表示されることを確かめる。
`requirements*.txt` は `uv.lock` から出力したもの（各ファイルの冒頭に出力コマンドがある）。
CI と同じく、これらのファイルからインストールする。

**ベースライン。** 各ゲートは、テストセットを `evaluation/baselines/` のコミット済み
ベースラインと比較する。合格基準を更新するのは人であり、パイプライン自身ではない。
質問、参照回答、評価器を変更した場合や独自の基準を使う場合に更新する。
日本語化前のスコアと来歴は保全してあるが、翻訳後のデータ・評価器とは互換性がないため、
ゲートは停止する。日本語版の評価器を明示的に登録し、新規評価の結果をレビューして
ベースラインを作成する。既存のスコアに新しいフィンガープリントを上書きしない。
以下は有料であり、実行前に許可が必要。`sample/` から実行する
（各約10分。2つの昇格用実行は順番に待機する）:

```bash
gh workflow run agent-pr.yml --ref jp -f write_baseline=true
gh workflow run agent-main.yml --ref jp -f mode=baseline-holdout
gh workflow run agent-main.yml --ref jp -f mode=baseline-drift
```

`gh run list --limit 3` で3件すべての完了を確認してから、ダウンロードする。
`jp-dev` の変更としてコミット・push し、`jp` を base とする PR で反映する。
`jp` への push により有料のリリース昇格が開始する。

```bash
rm -f evaluation/baselines/*.json      # gh は既存ファイルを上書きしない
gh run download --name baseline-approvers-development --dir evaluation/baselines
gh run download --name baseline-approvers-holdout --dir evaluation/baselines
gh run download --name baseline-approvers-drift --dir evaluation/baselines
git add evaluation/baselines && git commit -m "CI ベースライン" && git push
```

古いスコアに新しいフィンガープリントをコピーしない。テストセットや評価器の変更には新しいベースラインが必要。

## 発表前

評価は約10分、最適化は約1時間かかるため、事前に準備する。

1. ホールドアウト評価を2回実行する。その差がノイズ幅になる。
2. 最適化を実行し、最良の候補をレビューして事実コピー検査を実行する。
3. デモ6を準備する。レビュー済み候補をリリースへ昇格し、悪いプロンプトの PR は
  阻止された状態に保つ（`demo-commands.sh` の `open_pr`）。
4. デモ2の質問を3回リハーサルする。
5. ネットワーク障害時に備え、表示するポータル画面をすべて撮影する。
6. モデル比較、エージェント、ホールドアウト実行、最適化実行、GitHub Actions のタブと、
  仮想環境を有効にして `FOUNDRY_PROJECT_ENDPOINT` を設定した `sample/` のターミナルを開く。

## 登壇中

| # | スライド | 分 | 目的 |
| --- | --- | --- | --- |
| 1 | プロンプトから本番へ | 1 | 製品名ではなく、エージェントの基本パターン |
| 2 | アジェンダ | 1 | 各段階を支える技術 |
| 3 | エージェントの紹介 | 1 | 購入エージェントと夕食会の質問 |
| 4 | モデル選択 | 2 | 品質、速度、コスト、Model Router |
| 5 | **デモ1** モデル比較 | 2 | Foundry の1画面を示して次へ進む |
| 6 | グラウンディング | 4 | Foundry IQ: 規則。Fabric IQ: 予算残額。Work IQ: 判断日に承認できる人 |
| 7 | **デモ2** 初期エージェントの実行 | 5 | 夕食会、次に Marcus。1つの回答だけでは証拠にならない |
| 8 | 観測 | 1 | 呼び出し、入出力、時間、エラー |
| 9 | **デモ3** トレースの確認 | 3 | 実際のツール呼び出しと戻り値 |
| 10 | 評価 | 5 | 組み込み評価器と、このデモで使う評価器 |
| 11 | **デモ4** 複数ケースの評価 | 9 | 誤った次の行動、判定理由、ノイズ |
| 12 | 最適化 | 3 | 高いスコアは出荷の許可ではない |
| 13 | **デモ5** Agent Optimizer | 8 | スコア差とノイズ、規則とコピーされた事実 |
| 14 | 3つのテストセット | 4 | 宿題、模擬試験、抜き打ち試験 |
| 15 | ゲートの検査内容 | 2 | 安い検査から、固定値でなくベースライン、同じ条件で比較 |
| 16 | **デモ6** CI/CD パイプラインの例 | 5 | レビュー済み候補をリリース、悪いプロンプトは PR で阻止 |
| 17 | テストケースから本番へ | 2 | リリースへの一本道、最適化と新規評価の反復 |
| 18 | 1つのエージェント、1つの問い | 1 | 道のりを振り返り、変更を続けられる測定を作る |
| 19 | 次に深めたいこと | 1 | 次の学習先だけを紹介 |
| 20 | 作る、測る、改善する、繰り返す | 1 | まとめと質疑 |
| 21 | 参考資料 | 0 | 質疑中に撮影できるよう表示したままにする |
| 22-25 | AI Genius の締めくくり | 2 | アンケート QR、シリーズページ QR、バッジ、お礼 |

**デモ1。** モデル比較。最初に選んだモデルに固定する必要はない。評価が変更の時期を教えてくれる。

**デモ2。** 夕食会の質問をし、続けて *「はい、ワインも出ます。」* と伝える。
期待する回答: 直属上司の承認では足りない。ワインには接待責任者の承認が必要で、
Tim は休暇中、Priya が記録済みの代理人。次に Marcus の質問をする。
$5,000 超はカテゴリーマネージャーが必要。Marco は11月2日まで不在で代理人はいないため、
待つか購買部門に相談する（Leah の委任は直属上司の承認だけを対象とする）。
正解でも不正解でも要点は同じ。**1つの回答だけでは証拠にならない。**

**デモ3。** そのトレースを開き、モデル・ツールの呼び出し、入力、結果、時間を確認する。
何をしたかは分かるが、正しかったかは分からない。

**デモ4。** 準備したホールドアウト実行を開き、不合格の質問を選んで評価器の判定理由を読む。
開発とホールドアウトを比較し、ノイズ幅を説明する。平均だけでなく失敗を読む。

**デモ5。** Optimize タブを開く。スコア差をノイズと比較し、**View changes** で
指示*と*ツール説明を確認する。残す価値のある規則、コピーされた事実、抜けた内容を探す。
見せる価値のある結果がなければ `candidates/reviewed/` を使い、手動で改善したと説明する。
スコアが上がっても、人が変更を読む。

**デモ6。** レビュー済み PR の流れを示す。開発で合格、`-dev` でホールドアウト、レビュー、
ドリフト、リリース承認、`-release` へのデプロイ。次に悪いプロンプトの PR を示す。
オフライン検査は通るが開発セットで失敗し、ブランチ保護がマージを阻止する。マージしない。
事実コピー検査はモデルを使わない単純なスクリプト。新しい金額、日付、ID、名前を検出するが、
下の名前だけを見逃したことがあるため、人によるレビューも必要。

**テストケースから本番へ。** 必要なら継続的評価の **Monitor → Settings** を示すが、有効化しない。
本番のトラフィックには参照回答がないため、ルーブリックを使う。

## CI/CD

日本語版のブランチは次の役割で使う。

| ブランチ | 役割 |
| --- | --- |
| `jp` | 統合ブランチ。ここへのマージ・push 後にホールドアウトからリリースへの昇格を行う |
| `jp-dev` | 開発ブランチ。変更を作り、`jp` を base とする PR で開発セットを評価する |

デモ用の作業ブランチも PR の base は `jp` にする。GitHub の既定ブランチに依存せず、
`gh pr create --base jp` で送り先を明示する。既定ブランチやルールセット自体の変更は別作業である。
開発ブランチ `jp-dev` と、検証用エージェント名の末尾 `-dev` は別であり、エージェント名は変えない。

両ワークフローは `_agent-eval.yml` を使い、エージェントのデプロイ、テストセットの評価、
コミット済みベースラインとの比較を行う。Foundry プロジェクトは1つで、エージェント名でデプロイを分離する。

| エージェント | 目的 |
| --- | --- |
| `purchasing-advice-demo` | ライブの質問と最適化。CI はここにデプロイしない |
| `purchasing-advice-demo-pr-<number>` | PR ゲート: オフライン検査、次に開発セット |
| `purchasing-advice-demo-dev` | jp への push ごと: ホールドアウト、レビュー、次にドリフト |
| `purchasing-advice-demo-release` | ホールドアウト、レビュー、ドリフト、リリース承認の後にのみデプロイ |

ゲートは固定値を下回った場合ではなく、許容幅（PR ゲートは実測ノイズの0.07）を超えて
低下した場合に失敗する。リリースゲートは、ドリフトの不合格または未採点が1件でもあれば失敗する。
赤いチェックがマージを阻止するのは、`jp` のルールセットで必須チェック名
`1. Offline checks` と `2. Development set vs baseline` を要求した場合だけ。
これらの識別用の名前は翻訳しない。PR 用エージェントは自動削除されないため、デモ後に削除する。

## リハーサルコーチ（任意）

HTML スライドの**リハーサル**パネル（`R`）は、各スライドの時間を測り、Whisper でローカルに
文字起こしし、Decision-1 で各スライドの概念を採点する。使わなくてもスライドは通常どおり動く。

Node 24 以上、`az login`、`whisper-cpp` と `ffmpeg` が必要（`brew install whisper-cpp ffmpeg`）:

```bash
mkdir -p "$HOME/.cache/whisper" && curl --fail --location \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin \
  --output "$HOME/.cache/whisper/ggml-base.bin"
cd presentation/rehearsal && npm ci
DECISION_ENDPOINT="https://<account>.services.ai.azure.com/providers/microsoft/v1/systemone" \
DECISION_DEPLOYMENT="<deployment-name>" npm start
```

`http://127.0.0.1:4173/` を開き、**セットアップ確認**を選ぶ。同意にチェックを入れ
（Decision-1 の呼び出しは有料）、**リハーサル開始**を選ぶ。
一時停止するとマイクを解放し、**終了**でスライドごとのレビューを開く。
**LLM 用にコピー**は、文字起こしと実際のリクエスト・レスポンスをコピーする。
概念は `src/concepts.ts` にある。録音はブラウザーのタブ内に保持し、ダウンロードはリポジトリの外に置く。
コード変更後: `npm run build && npm test && npm run test:browser`。

## トラブルシューティング

| 症状 | 原因と対処 |
| --- | --- |
| トレースが `"search_mode": "keyword"` | `fallback_reason` を読む。401 はエージェントの ID の権限不足（10分待って `azd deploy`）。`stale` は `python agent/build_embeddings.py` を実行 |
| GitHub ログイン時の `No matching federated identity record` | `gh` にログインしてから `azd provision` |
| `azd up` が `githubRepository` 未指定で失敗 | `azd env set GITHUB_REPOSITORY <owner>/<name>` を実行してから `azd up` |
| `azd up` 後に GitHub 変数がない | `gh auth login`、次に `azd hooks run postprovision` |
| ワークフローが待機する | 別の評価がそのエージェントを使用中、または昇格の承認待ち |
| ベースラインに来歴がない、または入力が異なる | 正常と確認できたリビジョンでベースラインモードを実行し、成果物をレビューしてコミット |
| 登録済み評価器がローカル JSON と異なる | `python evaluation/evaluate.py --update-evaluators --register-only` を実行してベースラインを更新 |
| 未採点の質問がある | 評価器のレート制限。再実行し、繰り返す場合は `azure.yaml` の GPT-5.5 容量を増やして `azd provision` |
| モデルのデプロイがクォータ不足で失敗 | `azure.yaml` の `ai-project` 配下の容量を下げる |
