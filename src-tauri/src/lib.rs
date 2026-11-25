use serde::Serialize;

/// Variables genéricas (sirven para cualquier organización), en orden de prioridad.
/// AZURE_DEVOPS_EXT_PAT es la que usa el CLI de Azure DevOps.
const GENERIC_PAT_VARS: [&str; 3] = ["AZURE_DEVOPS_EXT_PAT", "AZURE_DEVOPS_PAT", "SCRUM_COCKPIT_PAT"];

/// Token encontrado y en qué variable de entorno estaba.
#[derive(Serialize)]
struct EnvPat {
    value: String,
    source: String,
}

/// Nombre de la variable específica de una organización:
/// "Mi-Org.2" -> "AZURE_DEVOPS_PAT_MI_ORG_2" (mayúsculas; todo lo que no sea
/// letra o número pasa a "_", porque muchas shells no aceptan otros caracteres).
fn org_var_name(org: &str) -> String {
    let normalized: String = org
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' })
        .collect();
    format!("AZURE_DEVOPS_PAT_{normalized}")
}

fn read_var(key: &str) -> Option<EnvPat> {
    let v = std::env::var(key).ok()?;
    let v = v.trim();
    if v.is_empty() {
        return None;
    }
    Some(EnvPat { value: v.to_string(), source: key.to_string() })
}

/// Lee el PAT de Azure DevOps desde variables de entorno.
/// Si se pasa `org`, primero busca la variable específica de esa organización
/// (AZURE_DEVOPS_PAT_<ORG>); si no está, cae a las genéricas.
#[tauri::command]
fn get_env_pat(org: Option<String>) -> Option<EnvPat> {
    if let Some(org) = org.as_deref().filter(|o| !o.trim().is_empty()) {
        if let Some(p) = read_var(&org_var_name(org)) {
            return Some(p);
        }
    }
    GENERIC_PAT_VARS.iter().find_map(|k| read_var(k))
}

/// Nombre de la variable específica para una organización (para mostrarlo en el Setup).
#[tauri::command]
fn pat_var_name(org: String) -> String {
    org_var_name(&org)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![get_env_pat, pat_var_name])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::org_var_name;

    #[test]
    fn nombre_de_variable_por_org() {
        assert_eq!(org_var_name("Aoniken"), "AZURE_DEVOPS_PAT_AONIKEN");
        assert_eq!(org_var_name(" mi-org.2 "), "AZURE_DEVOPS_PAT_MI_ORG_2");
    }
}
