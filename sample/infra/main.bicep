// Foundry プロジェクトサービスのプロビジョニング用テンプレート。
//
// 入力は internal/synthesis が azure.yaml の host: azure.ai.project のサービス定義から生成する。
// このエントリーポイントは新しい Foundry アカウントとプロジェクトを作る。
// 既存プロジェクトには別の編集可能なエントリーポイントを使う。
//
// サブスクリプションスコープにして、リソースグループもデプロイに含める。
// azd provision --preview では、リソースグループスコープの what-if のために事前作成せず、
// プレビュー上の Create として表示するため、副作用がない。

targetScope = 'subscription'

// ユーザー定義型

@description('azure.yaml のモデルデプロイ項目の型。')
type deploymentsType = deploymentType[]

@description('1件のモデルデプロイの型。')
type deploymentType = {
  name: string
  model: {
    name: string
    format: string
    version: string
  }
  sku: {
    name: string
    capacity: int
  }
}

// パラメーター

@description('すべてのリソースを配置する Azure リージョン。')
param location string

@description('作成し、リソースをデプロイするリソースグループの名前。')
@minLength(1)
@maxLength(90)
param resourceGroupName string

@description('すべてのリソースに適用するタグ。')
param tags object = {}

@description('再プロビジョニング時にリソース名を変えるための任意のソルト。')
param resourceTokenSalt string = ''

@description('Foundry プロジェクト名。英数字とハイフンで3〜32文字。')
@minLength(3)
@maxLength(32)
param foundryProjectName string

@description('Foundry アカウントにプロビジョニングするモデルデプロイ。')
param deployments deploymentsType = []

@description('Azure Container Registry を含める。docker: を使うエージェントがあれば true。')
param includeAcr bool = false

@description('azd を実行する開発者のオブジェクト ID。設定するとプロジェクトの Cognitive Services User を付与する。空ならロール割り当てを無効にし、非対話・CI 実行の失敗を避ける。')
param principalId string = ''

@description('開発者のロール割り当てに使うプリンシパルの種類。')
param principalType string = 'User'

// ネットワーク分離のパラメーター（意味は modules/resources.bicep 参照）。
// 既定ですべて無効。network: ブロックがなければ公開アカウントになる。

@description('全体のスイッチ。true ならアカウントを VNet に接続して非公開にする。')
param enableNetworkIsolation bool = false

@description('true で分離が有効なら、エージェントのランタイムは顧客サブネットではなく Microsoft 管理のネットワークを使う。')
param useManagedEgress bool = false

@description('既存の顧客 VNet の ARM ID（byo モード）。')
param vnetId string = ''

@description('エージェント用の委任サブネット名。')
param agentSubnetName string = 'agent-subnet'

@description('エージェント用サブネットの CIDR。空なら VNet のアドレス空間から /24 を生成する。')
param agentSubnetPrefix string = ''

@description('true ならエージェント用サブネットを作り、false なら既存のものを参照する。')
param createAgentSubnet bool = false

@description('プライベートエンドポイント用サブネット名。')
param peSubnetName string = 'pe-subnet'

@description('プライベートエンドポイント用サブネットの CIDR。空なら VNet のアドレス空間から /24 を生成する。')
param peSubnetPrefix string = ''

@description('true なら PE サブネットを作り、false なら既存のものを参照する。')
param createPESubnet bool = false

@description('管理ネットワークの分離モード（managed モード）。')
param managedIsolationMode string = ''

@description('既存のプライベート DNS ゾーンがあるリソースグループ。空なら新しいゾーンを作る。')
param dnsZonesResourceGroup string = ''

@description('既存のプライベート DNS ゾーンがあるサブスクリプション。空なら現在のものを使う。')
param dnsZonesSubscription string = ''

// このデモ用の追加項目（ここより上は生成されたテンプレート）。

@description('demo 環境からエージェントをデプロイ・評価できる GitHub リポジトリ（owner/name）。必須。preprovision フックで一度だけ尋ね、GITHUB_REPOSITORY に保存する。')
@minLength(3)
param githubRepository string

@description('GitHub が demo 環境用に送る正確な OIDC subject（preprovision フックが GitHub API から設定）。空なら従来の repo:owner/name:environment:demo 形式を使う。')
param githubOidcSubject string = ''

// リソース

resource resourceGroup 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module resources 'modules/resources.bicep' = {
  name: 'foundry-resources'
  scope: resourceGroup
  params: {
    location: location
    tags: tags
    resourceTokenSalt: resourceTokenSalt
    foundryProjectName: foundryProjectName
    deployments: deployments
    includeAcr: includeAcr
    principalId: principalId
    principalType: principalType
    enableNetworkIsolation: enableNetworkIsolation
    useManagedEgress: useManagedEgress
    vnetId: vnetId
    agentSubnetName: agentSubnetName
    agentSubnetPrefix: agentSubnetPrefix
    createAgentSubnet: createAgentSubnet
    peSubnetName: peSubnetName
    peSubnetPrefix: peSubnetPrefix
    createPESubnet: createPESubnet
    managedIsolationMode: managedIsolationMode
    dnsZonesResourceGroup: dnsZonesResourceGroup
    dnsZonesSubscription: dnsZonesSubscription
  }
}

// Application Insights、評価器のアクセス権（azd を実行する開発者）、GitHub Actions の ID。
// repo:<githubRepository>:environment:demo を信頼するユーザー割り当て ID。
module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  scope: resourceGroup
  params: {
    location: location
    environmentName: foundryProjectName
    accountName: resources.outputs.AZURE_AI_ACCOUNT_NAME
    projectName: resources.outputs.AZURE_AI_PROJECT_NAME
    evaluatorPrincipalId: principalId
    evaluatorPrincipalType: principalType == 'ServicePrincipal' ? 'ServicePrincipal' : 'User'
    githubRepository: githubRepository
    githubOidcSubject: githubOidcSubject
  }
}

// 出力

output AZURE_RESOURCE_GROUP string = resourceGroupName
output AZURE_FOUNDRY_RESOURCE_GROUP string = resourceGroupName
output AZURE_AI_PROJECT_ID string = resources.outputs.AZURE_AI_PROJECT_ID
output AZURE_AI_ACCOUNT_NAME string = resources.outputs.AZURE_AI_ACCOUNT_NAME
output AZURE_AI_PROJECT_NAME string = resources.outputs.AZURE_AI_PROJECT_NAME
output AZURE_OPENAI_ENDPOINT string = resources.outputs.AZURE_OPENAI_ENDPOINT
output FOUNDRY_PROJECT_ENDPOINT string = resources.outputs.FOUNDRY_PROJECT_ENDPOINT
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = resources.outputs.AZURE_CONTAINER_REGISTRY_ENDPOINT
output AZURE_CONTAINER_REGISTRY_RESOURCE_ID string = resources.outputs.AZURE_CONTAINER_REGISTRY_RESOURCE_ID
output AZURE_AI_PROJECT_ACR_CONNECTION_NAME string = resources.outputs.AZURE_AI_PROJECT_ACR_CONNECTION_NAME
output AZURE_FOUNDRY_NETWORK_MODE string = resources.outputs.AZURE_FOUNDRY_NETWORK_MODE
output AZURE_FOUNDRY_MANAGED_ISOLATION_MODE string = resources.outputs.AZURE_FOUNDRY_MANAGED_ISOLATION_MODE
// 独自の出力名は camelCase。Foundry プロバイダーは azd 環境へ渡す際に出力名を camelCase に変換する
// （APPLICATIONINSIGHTS_ID は applicationinsightS_ID になった）。元から camelCase なら変わらない。
// ${appInsightsId} などで参照する。
output appInsightsId string = monitoring.outputs.applicationInsightsId
#disable-next-line outputs-should-not-contain-secrets // azure.yaml の app-insights 接続が読み取る
output appInsightsConnectionString string = monitoring.outputs.applicationInsightsConnectionString
output githubClientId string = monitoring.outputs.githubClientId
output githubTenantId string = monitoring.outputs.githubTenantId
