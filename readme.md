# Agent Evaluation Demo

Microsoft Foundry と Microsoft Agent Framework を使い、エージェントの評価、
可観測性、最適化を紹介するプレゼンテーションと実行可能なサンプルです。

**モデル選択 -> グラウンディング -> トレース -> 評価 -> 最適化 -> CI/CD**

サンプルのエージェントは、架空のポリシー、職場の名簿、部門予算を使って購入に関する質問に
答えます。3つの読み取り専用ツールは Foundry IQ、Work IQ、Fabric IQ を模したローカルの
代替実装であり、実際のサービスには接続しません。

## はじめに

- [運用ガイド](PLAYBOOK.md): デモの進め方、前提条件、セットアップと実行コマンド。
- プレゼン資料: [HTML スライド](presentation/deck.html) または [PowerPoint](presentation/presentation.pptx)。
- [サンプル](sample/): エージェント、評価データセット、評価器、Azure 設定。

Azure でのホスティング、モデル呼び出し、テレメトリには料金が発生する場合があります。
デプロイや評価・最適化を始める前に、運用ガイドを確認してください。
