// Azure Blob Storage driver types
export interface AzureBlobAddition {
  endpoint: string
  access_key: string
  container_name: string
  sign_url_expire?: number
  root_folder_path?: string
}

export interface AzureListResult {
  blobs: Array<{ name: string; size: number; modified: string }>
  prefixes: string[]
  /** A-35：分页标记；非空时必须带 marker 继续列取。 */
  nextMarker?: string
}
