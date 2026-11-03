// microsoft.foundry サービスのリソースグループスコープのリソース。
// Foundry（AIServices）アカウント、プロジェクト、モデルデプロイ、
// 任意のコンテナーレジストリ、開発者のロール割り当てを含む。
//
// main.bicep がサブスクリプションスコープで作るリソースグループにデプロイする。
// main.bicep がサブスクリプションを対象にしてリソースグループを作れるよう別モジュールにし、
// これらのリソースはリソースグループスコープに保つ。

targetScope = 'resourceGroup'

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
param location string = resourceGroup().location

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

// ネットワーク分離のパラメーター。既定ですべて無効。
// azure.yaml に network: ブロックがなければ、ネットワーク対応前と同じ公開アカウントになる。

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

@description('管理ネットワークの分離モード（managed モード）。AllowInternetOutbound | AllowOnlyApprovedOutbound。')
param managedIsolationMode string = ''

@description('既存のプライベート DNS ゾーンがあるリソースグループ。空なら新しいゾーンを作り、リンクする。')
param dnsZonesResourceGroup string = ''

@description('既存のプライベート DNS ゾーンがあるサブスクリプション。空なら現在のものを使う。')
param dnsZonesSubscription string = ''

// 変数

var resourceToken = empty(resourceTokenSalt)
  ? uniqueString(subscription().id, resourceGroup().id, location)
  : uniqueString(subscription().id, resourceGroup().id, location, resourceTokenSalt)

var abbrs = loadJsonContent('../abbreviations.json')

var foundryAccountName = '${abbrs.cognitiveServicesAccounts}${resourceToken}'

// 送信: byo は顧客サブネットにエージェントを接続し、managed は Microsoft 管理ネットワークを使う。
// 受信: 分離が有効ならアカウントのプライベートエンドポイントを必ず作り、データプレーンを公開しない。
var useByoNetwork = enableNetworkIsolation && !useManagedEgress
var useManagedNetwork = enableNetworkIsolation && useManagedEgress
var disablePublicDataPlaneAccess = enableNetworkIsolation

// 組み込みロール定義 ID: https://learn.microsoft.com/azure/role-based-access-control/built-in-roles
var cognitiveServicesUserRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'a97b65f3-24c7-4388-baec-2e87135dc908'
)

// リソース

// 顧客 VNet の接続: VNet を参照し、エージェント用（byo の送信のみ）とプライベートエンドポイント用の
// サブネットを作成または参照する。アカウントのプライベートエンドポイントを必ず作るため、分離時は常に実行。
module network 'network.bicep' = if (enableNetworkIsolation) {
  name: 'foundry-network'
  params: {
    vnetId: vnetId
    agentSubnetName: agentSubnetName
    agentSubnetPrefix: agentSubnetPrefix
    createAgentSubnet: createAgentSubnet
    peSubnetName: peSubnetName
    peSubnetPrefix: peSubnetPrefix
    createPESubnet: createPESubnet
  }
}

// networkInjections はアカウントをエージェント用サブネット（byo）か
// Microsoft 管理ネットワーク（managed）に接続する。分離が無効なら null。
//
// subnetArmId は network!.outputs.agentSubnetId ではなく、具体的な vnetId から文字列で作る。
// アカウントとネットワークのモジュールは同じテンプレートでデプロイされるため、ここでのモジュール間
// reference() は CognitiveServices RP の事前検証時に未解決となり、networkInjections の型変換が失敗する。
// ARM what-if はこれを検出しない。決定的な ID で未解決参照を避け、ネットワークへの明示的な dependsOn で
// サブネットが先に存在する順序を保つ。
var agentSubnetArmId = '${vnetId}/subnets/${agentSubnetName}'
var agentNetworkInjections = useByoNetwork
  ? [
      {
        scenario: 'agent'
        subnetArmId: agentSubnetArmId
        useMicrosoftManagedNetwork: false
      }
    ]
  : (useManagedNetwork
      ? [
          {
            scenario: 'agent'
            useMicrosoftManagedNetwork: true
          }
        ]
      : null)

resource foundryAccount 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: foundryAccountName
  location: location
  tags: tags
  sku: {
    name: 'S0'
  }
  kind: 'AIServices'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    allowProjectManagement: true
    customSubDomainName: foundryAccountName
    publicNetworkAccess: disablePublicDataPlaneAccess ? 'Disabled' : 'Enabled'
    disableLocalAuth: true
    networkAcls: {
      defaultAction: disablePublicDataPlaneAccess ? 'Deny' : 'Allow'
      bypass: disablePublicDataPlaneAccess ? 'AzureServices' : null
      virtualNetworkRules: []
      ipRules: []
    }
    networkInjections: agentNetworkInjections
  }

  // 上記の決定的な ID で接続するため、Bicep はサブネットを作るネットワークモジュールへの依存を推論できない。
  // 接続前にサブネットが存在するよう、依存を明示する。
  dependsOn: useByoNetwork ? [network] : []

  // 同一アカウントへの同時デプロイは ARM が制限するため、モデルを順番にデプロイする。
  @batchSize(1)
  resource modelDeployments 'deployments' = [
    for d in deployments: {
      name: d.name
      properties: {
        model: d.model
      }
      sku: d.sku
    }
  ]

  resource project 'projects' = {
    name: foundryProjectName
    location: location
    identity: {
      type: 'SystemAssigned'
    }
    properties: {
      description: '${foundryProjectName} プロジェクト'
      displayName: foundryProjectName
    }
    // プロジェクト作成前に全モデルのデプロイが完了するよう dependsOn を明示する。
    // プロジェクトはモデルを参照しないため、Bicep が推論できる暗黙の依存はない。
    dependsOn: [
      modelDeployments
    ]
  }
}

// 管理ネットワークの分離（managed の送信のみ）。エージェントのランタイムを置く
// Microsoft 管理 VNet に、選択した送信分離モードを適用する。
// isolationMode を明示した場合だけデプロイし、それ以外はプラットフォームの既定を使う。
// AllowOnlyApprovedOutbound では、依存リソースへの接続に承認済み送信規則も必要。
// ここで使うプラットフォーム管理ストアの規則は、プラットフォームが管理する。
resource foundryManagedNetwork 'Microsoft.CognitiveServices/accounts/managednetworks@2025-10-01-preview' =
  if (useManagedNetwork && !empty(managedIsolationMode)) {
    parent: foundryAccount
    name: 'default'
    properties: {
      managedNetwork: {
        isolationMode: managedIsolationMode
      }
    }
  }

module acr 'acr.bicep' = if (includeAcr) {
  name: 'acr'
  params: {
    location: location
    tags: tags
    name: '${abbrs.containerRegistryRegistries}${resourceToken}'
    foundryAccountName: foundryAccount.name
    foundryProjectName: foundryAccount::project.name
    foundryProjectPrincipalId: foundryAccount::project.identity.principalId
    enableNetworkIsolation: enableNetworkIsolation
  }
}

// アカウントのプライベートエンドポイントと AI 用プライベート DNS ゾーン。
// 分離時は byo・managed のどちらでもエンドポイントを必ず作る。
// 依存ストアはプラットフォーム管理のままなので、エンドポイントはアカウントだけに付ける。
module privateEndpointDns 'private-endpoint-dns.bicep' = if (enableNetworkIsolation) {
  name: 'foundry-private-endpoint-dns'
  params: {
    aiAccountName: foundryAccount.name
    location: network!.outputs.vnetLocation
    vnetId: network!.outputs.vnetId
    peSubnetId: network!.outputs.peSubnetId
    suffix: resourceToken
    dnsZonesResourceGroup: dnsZonesResourceGroup
    dnsZonesSubscription: dnsZonesSubscription
  }
}

// 開発者が自分のマシンから Foundry のデータプレーン（chat/completions、agents API）を呼べるよう、
// プロジェクトの Cognitive Services User を付与する。
resource developerCognitiveServicesUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(principalId)) {
  name: guid(foundryAccount::project.id, principalId, cognitiveServicesUserRoleId)
  scope: foundryAccount::project
  properties: {
    principalId: principalId
    principalType: principalType
    roleDefinitionId: cognitiveServicesUserRoleId
  }
}

// 出力

output AZURE_AI_PROJECT_ID string = foundryAccount::project.id
output AZURE_AI_ACCOUNT_NAME string = foundryAccount.name
output AZURE_AI_PROJECT_NAME string = foundryAccount::project.name
output AZURE_OPENAI_ENDPOINT string = 'https://${foundryAccount.name}.openai.azure.com/'
output FOUNDRY_PROJECT_ENDPOINT string = 'https://${foundryAccount.name}.services.ai.azure.com/api/projects/${foundryAccount::project.name}'
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = includeAcr ? acr!.outputs.loginServer : ''
output AZURE_CONTAINER_REGISTRY_RESOURCE_ID string = includeAcr ? acr!.outputs.resourceId : ''
output AZURE_AI_PROJECT_ACR_CONNECTION_NAME string = includeAcr ? acr!.outputs.connectionName : ''
output AZURE_FOUNDRY_NETWORK_MODE string = !enableNetworkIsolation ? 'none' : (useManagedEgress ? 'managed' : 'byo')
output AZURE_FOUNDRY_MANAGED_ISOLATION_MODE string = useManagedNetwork ? managedIsolationMode : ''
