// ネットワークで保護した Foundry アカウント（VNet 接続）の仮想ネットワーク設定。
//
// 既存 VNet の持ち込み専用（network.mode: byo）。VNet は事前に存在する必要がある。
// v1 は azure.yaml で指定した ARM ID で参照する。各サブネットは合成処理の3状態の規則に従う:
//
//   create=true、prefix 指定あり -> 指定したプレフィックスでサブネットを作成
//   create=true、prefix 空       -> 自動生成した /24 プレフィックスで作成
//   create=false                -> 既存サブネットをそのまま参照
//
// サブネット ID はすべて決定的（<vnetId>/subnets/<name>）なので、ここで作った場合も
// 既存の場合も出力が有効になる。

targetScope = 'resourceGroup'

@description('既存の顧客 VNet の ARM リソース ID。')
param vnetId string

@description('エージェント用の委任サブネット名。')
param agentSubnetName string

@description('エージェント用サブネットの CIDR。空なら VNet のアドレス空間から /24 を生成する。')
param agentSubnetPrefix string = ''

@description('true ならエージェント用サブネットを作り、false なら既存のものを参照する。')
param createAgentSubnet bool

@description('プライベートエンドポイント用サブネット名。')
param peSubnetName string

@description('プライベートエンドポイント用サブネットの CIDR。空なら VNet のアドレス空間から /24 を生成する。')
param peSubnetPrefix string = ''

@description('true なら PE サブネットを作り、false なら既存のものを参照する。')
param createPESubnet bool

// VNet はデプロイ先とは別のリソースグループに存在する場合がある。
var vnetParts = split(vnetId, '/')
var vnetSubscriptionId = vnetParts[2]
var vnetResourceGroupName = vnetParts[4]
var vnetName = last(vnetParts)

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' existing = {
  name: vnetName
  scope: resourceGroup(vnetSubscriptionId, vnetResourceGroupName)
}

var vnetAddressSpace = vnet.properties.addressSpace.addressPrefixes[0]
var agentPrefix = empty(agentSubnetPrefix) ? cidrSubnet(vnetAddressSpace, 24, 0) : agentSubnetPrefix
var pePrefix = empty(peSubnetPrefix) ? cidrSubnet(vnetAddressSpace, 24, 1) : peSubnetPrefix

// ホスト型エージェントのコンテナーアプリ環境を接続できるよう、
// Microsoft.App/environments に委任したエージェント用サブネットを作る。
module agentSubnet 'subnet.bicep' = if (createAgentSubnet) {
  name: 'agent-subnet-${uniqueString(deployment().name, agentSubnetName)}'
  scope: resourceGroup(vnetSubscriptionId, vnetResourceGroupName)
  params: {
    vnetName: vnetName
    subnetName: agentSubnetName
    addressPrefix: agentPrefix
    delegations: [
      {
        name: 'Microsoft.App/environments'
        properties: {
          serviceName: 'Microsoft.App/environments'
        }
      }
    ]
  }
}

// プライベートエンドポイント用サブネットを作る。同一 VNet への2つの PUT が競合しないよう、
// エージェント用サブネットに依存させる（ARM はサブネットの書き込みを直列化する）。
module peSubnet 'subnet.bicep' = if (createPESubnet) {
  name: 'pe-subnet-${uniqueString(deployment().name, peSubnetName)}'
  scope: resourceGroup(vnetSubscriptionId, vnetResourceGroupName)
  params: {
    vnetName: vnetName
    subnetName: peSubnetName
    addressPrefix: pePrefix
    delegations: []
  }
  dependsOn: [
    agentSubnet
  ]
}

output vnetId string = vnet.id
output vnetName string = vnetName
output vnetLocation string = vnet.location
output vnetSubscriptionId string = vnetSubscriptionId
output vnetResourceGroupName string = vnetResourceGroupName
output agentSubnetId string = '${vnet.id}/subnets/${agentSubnetName}'
output peSubnetId string = '${vnet.id}/subnets/${peSubnetName}'
output peSubnetName string = peSubnetName
