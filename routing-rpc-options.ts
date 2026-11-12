/** Trusted deployment metadata only; absent pairs add no service capability. */
export function routingRpcOptions(values: Record<string, string | undefined>) {
  const worker = values["FUMI_ROUTING_RPC_WORKER"] ?? "";
  const exportName = values["FUMI_ROUTING_RPC_ENTRYPOINT"] ?? "";
  if (!worker && !exportName) return null;
  if (
    !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(worker) ||
    !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(exportName)
  )
    throw new Error("Invalid paired routing RPC configuration");
  return { worker, exportName };
}
