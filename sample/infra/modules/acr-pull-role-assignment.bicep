targetScope = 'resourceGroup'

@description('Azure Container Registry の名前。')
param registryName string

@description('レジストリの AcrPull を付与するプリンシパル。')
param principalId string

@description('AcrPull ロール定義のリソース ID。')
param roleDefinitionId string

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, principalId, roleDefinitionId)
  scope: registry
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: roleDefinitionId
  }
}
