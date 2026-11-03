// docker: を使うホスト型エージェント用の Azure Container Registry。
// Foundry プロジェクトのマネージド ID がイメージを取得できるよう、レジストリを接続として設定する。
//
// Premium SKU は意図的な選択。プロビジョニング後にコンテンツの信頼と geo レプリケーションを
// 有効にできるよう、Foundry は Premium を推奨する。

// パラメーター

@description('Azure リージョン。')
param location string

@description('すべてのリソースに適用するタグ。')
param tags object = {}

@description('レジストリ名。英数字で5〜50文字。')
@minLength(5)
@maxLength(50)
param name string

@description('ACR 接続を設定するプロジェクトをホストする、既存の Foundry CognitiveServices アカウント名。')
param foundryAccountName string

@description('ACR 接続を設定する既存の Foundry プロジェクト名。')
param foundryProjectName string

@description('Foundry プロジェクトのマネージド ID のプリンシパル ID。AcrPull を付与し、接続の認証 ID に使う。')
param foundryProjectPrincipalId string

@description('true ならレジストリの公開ネットワークアクセスを無効にし、分離境界内に保つ。')
param enableNetworkIsolation bool = false

// 変数

// 組み込みロール定義 ID: https://learn.microsoft.com/azure/role-based-access-control/built-in-roles
var acrPullRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)

// リソース

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: 'Premium'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    adminUserEnabled: false
    // ネットワーク分離時は公開アクセスを無効にし、レジストリを VNet 境界内に保つ。
    // 分離したプロジェクトの Docker エージェントはプライベートエンドポイントで取得する。
    // 公開アクセスでは依存先が分離境界の外に残り、送信制限下で取得に失敗する場合がある。
    publicNetworkAccess: enableNetworkIsolation ? 'Disabled' : 'Enabled'
    zoneRedundancy: 'Disabled'
  }
}

// ホスト型エージェントがプロジェクトの ID でイメージを取得できるよう、
// Foundry プロジェクトのマネージド ID にこのレジストリの AcrPull を付与する。
resource foundryAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, foundryProjectPrincipalId, acrPullRoleId)
  scope: registry
  properties: {
    principalId: foundryProjectPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleId
  }
}

// 接続をプロジェクト配下に置くための既存親リソースの参照。
// GA 2025-06-01 では projects/connections の ContainerRegistry サブリソースを解決できないため、
// 2025-04-01-preview に固定する（MissingApiVersionParameter）。
resource foundryAccount 'Microsoft.CognitiveServices/accounts@2025-04-01-preview' existing = {
  name: foundryAccountName

  resource project 'projects' existing = {
    name: foundryProjectName

    // Foundry が名前でレジストリを解決できるよう、接続をプロジェクトスコープにする。
    resource acrConnection 'connections' = {
      name: '${name}-conn'
      properties: {
        category: 'ContainerRegistry'
        target: registry.properties.loginServer
        authType: 'ManagedIdentity'
        // RegistryIdentity 認証には ID のクライアント ID（プロジェクトのプリンシパル）と
        // レジストリのリソース ID の両方が必要。
        credentials: {
          clientId: foundryProjectPrincipalId
          resourceId: registry.id
        }
        isSharedToAll: true
        metadata: {
          ResourceId: registry.id
        }
      }
      dependsOn: [
        foundryAcrPull
      ]
    }
  }
}

// 出力

output loginServer string = registry.properties.loginServer
output resourceId string = registry.id
output connectionName string = foundryAccount::project::acrConnection.name
