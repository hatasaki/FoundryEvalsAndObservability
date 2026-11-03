// 監視、評価器のアクセス権、GitHub Actions の ID。main.bicep のモジュール。
param location string = resourceGroup().location
param environmentName string
param accountName string
param projectName string
@description('評価を送信するユーザーまたはサービスプリンシパルのオブジェクト ID。空ならロールを付けない。')
param evaluatorPrincipalId string = ''
@allowed([
  'User'
  'ServicePrincipal'
])
param evaluatorPrincipalType string = 'User'
@description('demo 環境で信頼する GitHub の owner/repository。空なら GitHub の ID を無効にする。')
param githubRepository string = ''
@description('プロジェクトの ID が Application Insights の Monitoring Reader を取得済みなら true（ポータルで接続すると Foundry が付与する）。Azure は重複割り当てを拒否するため、この値で省略する。')
param projectTraceReaderExists bool = false

var enableGitHub = !empty(githubRepository)
@description('GitHub が送る正確な OIDC subject。例: repo:owner@123/name@456:environment:demo（所有者とリポジトリの ID を含む）。空なら従来の repo:owner/name 形式を使う。')
param githubOidcSubject string = ''

var githubSubject = empty(githubOidcSubject) ? 'repo:${githubRepository}:environment:demo' : githubOidcSubject

resource githubIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = if (enableGitHub) {
  name: 'id-${environmentName}-github'
  location: location
}

resource githubFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2024-11-30' = if (enableGitHub) {
  parent: githubIdentity
  name: 'github-demo'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    audiences: [
      'api://AzureADTokenExchange'
    ]
    subject: githubSubject
  }
}

resource account 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: accountName
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' existing = {
  parent: account
  name: projectName
}

// 評価器はアカウントレベルの推論を使う。プロジェクトのみ、または OpenAI のみの権限では不足する。
var inferenceRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '53ca6127-db72-4b80-b1b0-d745d6d5456d' // Foundry User（旧 Azure AI User）
)
resource evaluatorInference 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(evaluatorPrincipalId)) {
  name: guid(account.id, evaluatorPrincipalId, inferenceRoleId)
  scope: account
  properties: {
    roleDefinitionId: inferenceRoleId
    principalId: evaluatorPrincipalId
    principalType: evaluatorPrincipalType
  }
}

resource githubInference 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableGitHub) {
  name: guid(account.id, githubIdentity!.id, inferenceRoleId)
  scope: account
  properties: {
    roleDefinitionId: inferenceRoleId
    principalId: githubIdentity!.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

var contributorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'b24988ac-6180-42a0-ab88-20f7382dd24c'
)
resource githubDeployment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableGitHub) {
  name: guid(project.id, githubIdentity!.id, contributorRoleId)
  scope: project
  properties: {
    roleDefinitionId: contributorRoleId
    principalId: githubIdentity!.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource projectAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(project.id, inferenceRoleId)
  scope: project
  properties: {
    roleDefinitionId: inferenceRoleId
    principalId: project.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${environmentName}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${environmentName}'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
  }
}

var monitoringReaderRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '43d0d8ad-25c7-4714-9337-8ba259a9fe05' // Monitoring Reader（監視の読み取り権限）
)
resource projectTraceReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!projectTraceReaderExists) {
  name: guid(insights.id, project.id, monitoringReaderRoleId)
  scope: insights
  properties: {
    roleDefinitionId: monitoringReaderRoleId
    principalId: project.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// プロジェクトの Application Insights 接続は azure.yaml（app-insights、host: azure.ai.connection）で定義する。
// Foundry プロバイダーは Bicep での接続定義を受け付けなくなった。
#disable-next-line outputs-should-not-contain-secrets // azure.yaml の接続サービスが使う
output applicationInsightsConnectionString string = insights.properties.ConnectionString
output applicationInsightsId string = insights.id
output applicationInsightsAppId string = insights.properties.AppId
output githubIdentityId string = enableGitHub ? githubIdentity!.id : ''
output githubClientId string = enableGitHub ? githubIdentity!.properties.clientId : ''
output githubTenantId string = enableGitHub ? githubIdentity!.properties.tenantId : ''
output githubFederatedSubject string = enableGitHub ? githubSubject : ''
