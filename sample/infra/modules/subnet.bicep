// 既存 VNet 内の単一サブネット。親が VNet のリソースグループ（デプロイ先と異なる場合もある）に
// サブネットを配置し、モジュールの dependsOn で書き込みを直列化できるよう別モジュールにする。

targetScope = 'resourceGroup'

@description('サブネットが所属する仮想ネットワーク名。')
param vnetName string

@description('作成するサブネット名。')
param subnetName string

@description('サブネットの CIDR。')
param addressPrefix string

@description('サブネットの委任（例: エージェント用の Microsoft.App/environments）。')
param delegations array = []

resource subnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  name: '${vnetName}/${subnetName}'
  properties: {
    addressPrefix: addressPrefix
    delegations: delegations
  }
}

output subnetId string = subnet.id
output subnetName string = subnetName
