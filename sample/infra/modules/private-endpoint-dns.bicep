// ネットワークで保護した Foundry アカウントのプライベートエンドポイントと3つの AI 用 DNS ゾーン。
// 依存ストアはプラットフォーム管理のままなので、ここではアカウント自体にだけ
// プライベートエンドポイントを付ける。Search、Storage、Cosmos のエンドポイントは作らない。
//
// 既定では DNS ゾーンを作り、VNet にリンクする。dnsZonesResourceGroup を指定すると、
// 新規作成せず、そのリソースグループ内のゾーンを参照する。
// サブスクリプションは dnsZonesSubscription を使い、空なら現在のものを使う。

targetScope = 'resourceGroup'

@description('プライベートエンドポイントを接続する Foundry（AIServices）アカウント名。')
param aiAccountName string

@description('顧客 VNet の Azure リージョン。')
param location string

@description('顧客 VNet の ARM リソース ID。')
param vnetId string

@description('プライベートエンドポイント用サブネットの ARM リソース ID。')
param peSubnetId string

@description('リソース・リンク名を一意にする接尾辞。')
param suffix string

@description('既存のプライベート DNS ゾーンがあるリソースグループ。空なら新しいゾーンを作り、リンクする。')
param dnsZonesResourceGroup string = ''

@description('既存のプライベート DNS ゾーンがあるサブスクリプション。空なら現在のものを使う。')
param dnsZonesSubscription string = ''

var aiServicesDnsZoneName = 'privatelink.services.ai.azure.com'
var openAiDnsZoneName = 'privatelink.openai.azure.com'
var cognitiveServicesDnsZoneName = 'privatelink.cognitiveservices.azure.com'

var useExistingZones = !empty(dnsZonesResourceGroup)
var existingZonesSubscription = empty(dnsZonesSubscription) ? subscription().subscriptionId : dnsZonesSubscription

resource aiAccount 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: aiAccountName
  scope: resourceGroup()
}

// PE サブネット内に、account グループを対象とするアカウントのプライベートエンドポイントを作る。
resource aiAccountPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${aiAccountName}-private-endpoint'
  location: location
  properties: {
    subnet: {
      id: peSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${aiAccountName}-private-link-service-connection'
        properties: {
          privateLinkServiceId: aiAccount.id
          groupIds: [
            'account'
          ]
        }
      }
    ]
  }
}

// ---- プライベート DNS ゾーン: 作成してリンク、または既存参照 ----

resource aiServicesZone 'Microsoft.Network/privateDnsZones@2020-06-01' = if (!useExistingZones) {
  name: aiServicesDnsZoneName
  location: 'global'
}
resource existingAiServicesZone 'Microsoft.Network/privateDnsZones@2020-06-01' existing = if (useExistingZones) {
  name: aiServicesDnsZoneName
  scope: resourceGroup(existingZonesSubscription, dnsZonesResourceGroup)
}
var aiServicesZoneId = useExistingZones ? existingAiServicesZone.id : aiServicesZone.id

resource openAiZone 'Microsoft.Network/privateDnsZones@2020-06-01' = if (!useExistingZones) {
  name: openAiDnsZoneName
  location: 'global'
}
resource existingOpenAiZone 'Microsoft.Network/privateDnsZones@2020-06-01' existing = if (useExistingZones) {
  name: openAiDnsZoneName
  scope: resourceGroup(existingZonesSubscription, dnsZonesResourceGroup)
}
var openAiZoneId = useExistingZones ? existingOpenAiZone.id : openAiZone.id

resource cognitiveServicesZone 'Microsoft.Network/privateDnsZones@2020-06-01' = if (!useExistingZones) {
  name: cognitiveServicesDnsZoneName
  location: 'global'
}
resource existingCognitiveServicesZone 'Microsoft.Network/privateDnsZones@2020-06-01' existing = if (useExistingZones) {
  name: cognitiveServicesDnsZoneName
  scope: resourceGroup(existingZonesSubscription, dnsZonesResourceGroup)
}
var cognitiveServicesZoneId = useExistingZones ? existingCognitiveServicesZone.id : cognitiveServicesZone.id

// ---- VNet リンク（ゾーンを新規作成する場合のみ） ----

resource aiServicesLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (!useExistingZones) {
  parent: aiServicesZone
  name: 'aiServices-${suffix}-link'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnetId
    }
    registrationEnabled: false
  }
}
resource openAiLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (!useExistingZones) {
  parent: openAiZone
  name: 'aiServicesOpenAI-${suffix}-link'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnetId
    }
    registrationEnabled: false
  }
}
resource cognitiveServicesLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (!useExistingZones) {
  parent: cognitiveServicesZone
  name: 'aiServicesCognitiveServices-${suffix}-link'
  location: 'global'
  properties: {
    virtualNetwork: {
      id: vnetId
    }
    registrationEnabled: false
  }
}

// ---- DNS ゾーングループで3つのゾーンをアカウントのエンドポイントに関連付ける ----

resource aiAccountDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: aiAccountPrivateEndpoint
  name: '${aiAccountName}-dns-group'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: '${aiAccountName}-dns-aiserv-config'
        properties: {
          privateDnsZoneId: aiServicesZoneId
        }
      }
      {
        name: '${aiAccountName}-dns-openai-config'
        properties: {
          privateDnsZoneId: openAiZoneId
        }
      }
      {
        name: '${aiAccountName}-dns-cogserv-config'
        properties: {
          privateDnsZoneId: cognitiveServicesZoneId
        }
      }
    ]
  }
  dependsOn: [
    aiServicesLink
    openAiLink
    cognitiveServicesLink
  ]
}
