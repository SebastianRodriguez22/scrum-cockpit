import { invoke } from "@tauri-apps/api/core";

/** Token leído de una variable de entorno, y en cuál estaba */
export interface EnvPat {
  value: string;
  /** Nombre de la variable, ej "AZURE_DEVOPS_PAT_AONIKEN" o "AZURE_DEVOPS_EXT_PAT" */
  source: string;
}

/**
 * Lee el PAT desde variables de entorno. Si se pasa la organización, primero
 * busca la variable específica (AZURE_DEVOPS_PAT_<ORG>) y si no está usa las
 * genéricas (AZURE_DEVOPS_EXT_PAT y similares).
 */
export async function getEnvPat(org?: string): Promise<EnvPat | null> {
  try {
    return (await invoke<EnvPat | null>("get_env_pat", { org: org?.trim() || null })) ?? null;
  } catch {
    return null;
  }
}

/** Nombre de la variable específica para una organización (ej "AZURE_DEVOPS_PAT_AONIKEN") */
export async function patVarName(org: string): Promise<string> {
  try {
    return await invoke<string>("pat_var_name", { org });
  } catch {
    return "AZURE_DEVOPS_PAT_<ORG>";
  }
}
