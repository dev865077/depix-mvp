export function createTenantRegistryKv(registry) {
  return {
    async get(key) {
      return key === "TENANT_REGISTRY" ? registry : null;
    },
  };
}

export function withTenantRegistryKv(overrides = {}, defaultRegistry) {
  const registry = Object.prototype.hasOwnProperty.call(overrides, "TENANT_REGISTRY")
    ? overrides.TENANT_REGISTRY
    : defaultRegistry;
  const hasTenantRegistryKvOverride = Object.prototype.hasOwnProperty.call(overrides, "TENANT_REGISTRY_KV");
  const {
    TENANT_REGISTRY: _tenantRegistry,
    TENANT_REGISTRY_KV: tenantRegistryKv,
    ...rest
  } = overrides;

  return {
    TENANT_REGISTRY_KV: hasTenantRegistryKvOverride ? tenantRegistryKv : createTenantRegistryKv(registry),
    ...rest,
  };
}
