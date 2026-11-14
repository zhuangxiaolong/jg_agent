import type { ProviderProfile } from './index';

/** 判断文本是否包含独立的 Grok 标识，避免把 ordinary 的子串误判为 Grok 模型。 */
function hasGrokMarker(value: string | undefined): boolean {
  return typeof value === 'string' && /(?:^|[^a-z0-9])grok(?:$|[^a-z0-9]|\d)/i.test(value);
}

/**
 * 判断模型是否属于 Grok。
 *
 * Grok 配置中的 profiles 只是协议元数据，可能由共享中转站和模型投影而来，
 * 因此这里仅根据中转站标识/名称、模型 ID 及模型目录名称判定归属。
 */
export function isGrokModel(provider: Pick<ProviderProfile, 'id' | 'name' | 'modelCatalog'>, modelId: string): boolean {
  if (hasGrokMarker(provider.id) || hasGrokMarker(provider.name) || hasGrokMarker(modelId)) return true;
  const catalogModel = provider.modelCatalog?.find(model => model.id === modelId);
  return hasGrokMarker(catalogModel?.id) || hasGrokMarker(catalogModel?.name);
}
